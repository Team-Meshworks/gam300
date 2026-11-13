using System.Data;
using Spatia.Server.Accounts;
using Microsoft.EntityFrameworkCore;
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
            if (account is null) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
            if (account.MustChangePassword) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.PasswordChangeRequired); }
            // Join bytes through the same current-membership query used by project lists
            var image = await (from project in access.VisibleProjects(account)
                               join stored in database.ProjectImages.AsNoTracking() on project.ImageId equals stored.Id
                               where project.Id == id
                               select stored).SingleOrDefaultAsync(cancellationToken);
            if (image is null) { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.NotFound); }
            await transaction.CommitAsync(cancellationToken);
            if (context.Features.Get<ValidatedAccountSession>() is not { } session || session.Clock.GetUtcNow() >= session.ExpiresUtc)
            { return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired); }
            // Never let a previous account's cached image outlive its current project permission
            context.Response.Headers.CacheControl = "private, no-store";
            context.Response.Headers.XContentTypeOptions = "nosniff";
            context.Response.Headers.ContentSecurityPolicy = "default-src 'none'; sandbox";
            return Results.Bytes(image.Data, image.ContentType);
        }).RequireAuthorization(SecurityPolicies.FullAccount);
        return endpoints;
    }
}
