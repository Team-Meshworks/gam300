using Spatia.Server.Hosting;

namespace Spatia.Server.Projects;

/// <summary>
/// Converts project access and save outcomes into safe public HTTP responses
/// </summary>
public static class ProjectHttpResults
{
    /// <summary>
    /// Maps a project access denial to its public problem status and error code
    /// </summary>
    /// <param name="context">The request context supplying response headers and the trace identifier</param>
    /// <param name="failure">The access denial returned by project authorization</param>
    /// <returns>A problem result with the corresponding 401, 403 or 404 status</returns>
    /// <exception cref="ArgumentNullException"><paramref name="context"/> is null</exception>
    /// <exception cref="ArgumentOutOfRangeException">
    /// <paramref name="failure"/> is not a defined access failure
    /// </exception>
    public static IResult FromAccessFailure(HttpContext context, ProjectAccessFailure failure)
    {
        ArgumentNullException.ThrowIfNull(context);
        (int Status, string Code, string Title) problem = failure switch
        {
            ProjectAccessFailure.AuthenticationRequired =>
                (401, "authentication_required", "A valid session is required."),
            ProjectAccessFailure.PasswordChangeRequired =>
                (403, "password_change_required", "Change your password before opening projects."),
            ProjectAccessFailure.NotFound =>
                (404, "project_not_found", "The project was not found."),
            ProjectAccessFailure.OperationForbidden =>
                (403, "access_denied", "This operation is not permitted."),
            ProjectAccessFailure.ProjectReadOnly =>
                (403, "project_read_only", "This project is read-only."),
            _ => throw new ArgumentOutOfRangeException(nameof(failure)),
        };
        return ApiProblems.Create(context, problem.Status, problem.Code, problem.Title);
    }

    /// <summary>
    /// Maps a completed service outcome without serializing its internal result wrapper
    /// </summary>
    /// <param name="context">The request context supplying response headers and the trace identifier</param>
    /// <param name="result">The completed authorized save outcome</param>
    /// <returns>A success acknowledgement, access problem, or 409 problem carrying the current revision</returns>
    /// <exception cref="ArgumentNullException">The context or result is null</exception>
    /// <exception cref="InvalidOperationException">The result does not describe a completed save outcome</exception>
    // TODO: Use ProjectSaveService outcomes from SCRUM-50-validated requests with server-derived digests
    public static IResult FromSave(HttpContext context, ProjectSaveResult result)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(result);
        if (result.AccessFailure is { } failure)
        {
            return FromAccessFailure(context, failure);
        }
        if (result.Acknowledgement is { } acknowledgement)
        {
            context.Response.Headers.CacheControl = "no-store";
            return Results.Ok(acknowledgement);
        }
        if (result.Rejection is ProjectSaveDecision.Conflict or ProjectSaveDecision.RevisionExhausted
            && result.CurrentRevision is >= 0 and <= Project.MaxRevision)
        {
            var exhausted = result.Rejection == ProjectSaveDecision.RevisionExhausted;
            var problem = ApiProblems.Create(context, 409,
                exhausted ? "revision_exhausted" : "revision_conflict",
                exhausted ? "The project cannot accept another revision." : "The project changed; reload before saving.");
            problem.ProblemDetails.Extensions["currentRevision"] = result.CurrentRevision.Value;
            return problem;
        }
        throw new InvalidOperationException("A completed authorized save result is required.");
    }
}
