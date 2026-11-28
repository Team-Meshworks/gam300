using System.Data;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Spatia.Server.Classes;
using Spatia.Server.Hosting;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;
using Spatia.Server.Security;

namespace Spatia.Server.Projects;

/// <summary>Delivers draft imagery only while the current account can still read its project</summary>
public static class ProjectImageEndpoints
{
    public static IEndpointRouteBuilder MapProjectImages(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/projects/{id:guid}/image", async (Guid id, HttpContext context,
            ProjectAccessService access, ApplicationDbContext database, CancellationToken cancellationToken) =>
        {
            await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, cancellationToken);
            var account = await access.ResolveCurrentAccountAsync(context, cancellationToken);

            if (account is null)
                return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired);

            if (account.MustChangePassword)
                return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.PasswordChangeRequired);

            // Join bytes through the same current-membership query used by project lists
            var image = await (from project in access.VisibleProjects(account)
                               join stored in database.ProjectImages.AsNoTracking() on project.ImageId equals stored.Id
                               where project.Id == id
                               select stored).SingleOrDefaultAsync(cancellationToken);

            if (image is null)
                return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.NotFound);

            await transaction.CommitAsync(cancellationToken);

            if (context.Features.Get<ValidatedAccountSession>() is not { } session || session.Clock.GetUtcNow() >= session.ExpiresUtc)
                return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired);

            // Never let a previous account's cached image outlive its current project permission
            context.Response.Headers.CacheControl = "private, no-store";
            context.Response.Headers.XContentTypeOptions = "nosniff";
            context.Response.Headers.ContentSecurityPolicy = "default-src 'none'; sandbox";
            return Results.Bytes(image.Data, image.ContentType);
        }).RequireAuthorization(SecurityPolicies.FullAccount);
        endpoints.MapPut("/projects/{id:guid}/image", ReplaceAsync)
            .RequireAuthorization(SecurityPolicies.FullAccount)
            .RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit)
            .WithMetadata(new RequestSizeLimitAttribute(3 * 1024 * 1024));
        return endpoints;
    }

    private sealed record ReplaceProjectImageRequest(DateTimeOffset ExpectedUpdatedAt, ProjectImageUpload? Image);

    private static async Task<IResult> ReplaceAsync(Guid id, ReplaceProjectImageRequest request, HttpContext context,
        ProjectAccessService access, ApplicationDbContext database, CancellationToken cancellationToken)
    {
        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var locked = await access.LockAsync(context, id, ProjectLockPurpose.ManageAssignments, cancellationToken);
        if (locked.Failure is { } denial)
            return ProjectHttpResults.FromAccessFailure(context, denial);

        var actor = await access.ResolveCurrentAccountAsync(context, cancellationToken);
        if (actor?.Role != ApplicationRoles.Educator || actor.UserId != locked.Snapshot!.ActorId)
            return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.OperationForbidden);

        if (await database.ClassAssignments.AnyAsync(row => row.SourceProjectId == id, cancellationToken)
            || await database.ClassAssignmentStudents.AnyAsync(row => row.ProjectId == id, cancellationToken))
        {
            return ApiProblems.Create(context, 409, "class_project_image", "Change the image from the class assignment.");
        }

        var image = request.Image is null ? null : ProjectImageValidation.Read(request.Image);
        if (image is null)
            return ApiProblems.Create(context, 422, "invalid_project_image", "Choose a valid PNG, JPEG or WebP image within the image limits.");

        var project = await database.Projects.SingleAsync(row => row.Id == id, cancellationToken);
        var previousImage = project.ImageId;
        var previous = await database.ProjectImages.AsNoTracking().SingleOrDefaultAsync(row => row.Id == previousImage, cancellationToken);
        if (previous is null || previous.Type != image.Type || previous.ContentType != image.ContentType
            || !previous.Data.AsSpan().SequenceEqual(image.Data))
        {
            if (project.UpdatedAt != request.ExpectedUpdatedAt)
                return ApiProblems.Create(context, 409, "project_changed", "Refresh the project before replacing its image.");

            database.ProjectImages.Add(image);
            project.ImageId = image.Id;
            project.UpdatedAt = DateTimeOffset.FromUnixTimeMilliseconds(Math.Max(
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), project.UpdatedAt.ToUnixTimeMilliseconds() + 1));
            await database.SaveChangesAsync(cancellationToken);
            if (previousImage is not null)
            {
                await database.ProjectImages.Where(row => row.Id == previousImage && !database.Projects.Any(p => p.ImageId == row.Id))
                    .ExecuteDeleteAsync(cancellationToken);
            }
        }

        return await ClassroomEndpoints.CompleteAsync(context, transaction, Results.Ok(new
        {
            image = new ProjectImageMetadata(image.Type, $"/api/v1/projects/{id:D}/image"),
            project.UpdatedAt,
        }), cancellationToken);
    }
}
