using System.Data;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Security;

namespace Spatia.Server.Hosting;

internal static class CreationOperationEndpoints
{
    internal static IEndpointRouteBuilder MapCreationOperations(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/creation-operations").RequireAuthorization(SecurityPolicies.FullAccount);
        group.MapGet("/{purpose}", GetAsync);
        group.MapPost("/{purpose}/{operationId:guid}/acknowledge", AcknowledgeAsync)
            .RequireRateLimiting(SecurityPolicies.AccountWriteRateLimit);
        return endpoints;
    }

    private static async Task<IResult> GetAsync(string purpose, HttpContext context, ApplicationDbContext database,
        ProjectAccessService access, CancellationToken cancellationToken)
    {
        if (!CreationReceipts.ValidPurpose(purpose))
            return InvalidInput(context);

        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var actorId = context.Features.Get<ValidatedAccountSession>()?.UserId;

        if (actorId is null)
            return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired);

        await CreationReceipts.LockPurposeAsync(database, actorId.Value, purpose, cancellationToken);
        var account = await access.ResolveCurrentAccountAsync(context, cancellationToken);

        if (account is null)
            return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired);

        if (account.MustChangePassword)
            return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.PasswordChangeRequired);

        var receipts = database.Set<CreationReceipt>().AsNoTracking().Where(row => row.ActorId == actorId && row.Purpose == purpose);
        var outstanding = await receipts.Where(row => !row.Acknowledged).OrderByDescending(row => row.Sequence).FirstOrDefaultAsync(cancellationToken);
        var operationId = outstanding?.OperationId ?? await receipts.OrderByDescending(row => row.Sequence)
            .Select(row => (Guid?)row.OperationId).FirstOrDefaultAsync(cancellationToken);
        JsonElement? representation = null;

        if (outstanding?.ResponseJson is { } json
            && await CreationReceipts.AccessFailureAsync(context, database, access, outstanding, cancellationToken, requireSource: true) is null)
        {
            representation = JsonSerializer.Deserialize<JsonElement>(json);
        }

        if (await CreationReceipts.RevalidateAsync(context, access, account, cancellationToken) is { } failure)
            return failure;

        await transaction.CommitAsync(cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();

        if (Expired(context))
            return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired);

        context.Response.Headers.CacheControl = "no-store";
        return Results.Ok(new
        {
            operationId,
            state = outstanding is null ? "ready" : "unacknowledged",
            receipt = representation
        });
    }

    private static async Task<IResult> AcknowledgeAsync(string purpose, Guid operationId, AcknowledgeRequest request,
        HttpContext context, ApplicationDbContext database, ProjectAccessService access, CancellationToken cancellationToken)
    {
        if (!CreationReceipts.ValidPurpose(purpose) || operationId == Guid.Empty)
            return InvalidInput(context);

        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var actorId = context.Features.Get<ValidatedAccountSession>()?.UserId;

        if (actorId is null)
            return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired);

        await CreationReceipts.LockPurposeAsync(database, actorId.Value, purpose, cancellationToken);
        var account = await access.ResolveCurrentAccountAsync(context, cancellationToken);

        if (account is null)
            return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.AuthenticationRequired);

        if (account.MustChangePassword)
            return ProjectHttpResults.FromAccessFailure(context, ProjectAccessFailure.PasswordChangeRequired);

        var changed = await database.Set<CreationReceipt>().Where(row => row.ActorId == actorId && row.Purpose == purpose && row.OperationId == operationId)
            .ExecuteUpdateAsync(set => set.SetProperty(row => row.Acknowledged, true), cancellationToken);

        if (changed == 0)
            return ApiProblems.Create(context, 404, "creation_operation_not_found", "The creation operation is unavailable.");

        if (await CreationReceipts.RevalidateAsync(context, access, account, cancellationToken) is { } failure)
            return failure;

        await transaction.CommitAsync(cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();

        if (Expired(context))
            return CommittedWrite.WithoutRepresentation(context);

        context.Response.Headers.CacheControl = "no-store";
        return Results.NoContent();
    }

    private static bool Expired(HttpContext context) => context.Features.Get<ValidatedAccountSession>() is not { } session
        || session.Clock.GetUtcNow() >= session.ExpiresUtc;

    private static IResult InvalidInput(HttpContext context) =>
        ApiProblems.Create(context, 400, "invalid_creation_operation", "Check the creation purpose and operation ID.");

    private sealed record AcknowledgeRequest;
}
