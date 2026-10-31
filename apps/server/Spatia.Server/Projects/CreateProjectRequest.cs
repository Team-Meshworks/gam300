using System.Text.Json;

namespace Spatia.Server.Projects;

/// <summary>
/// Creates a blank room or imports a validated document into the caller's organization
/// </summary>
public sealed record CreateProjectRequest
{
    /// <summary>Gets the new project's bounded title</summary>
    public required string Title { get; init; }
    /// <summary>Gets an approved environment asset for a blank project</summary>
    public string? EnvironmentAssetId { get; init; }
    /// <summary>Gets the complete imported document, mutually exclusive with an environment asset</summary>
    public JsonElement? Document { get; init; }
    /// <summary>Gets the active organization selected by a global administrator</summary>
    public Guid? OrgId { get; init; }
}
