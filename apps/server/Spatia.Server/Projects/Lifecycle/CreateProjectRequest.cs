using System.Text.Json;
using System.Text.Json.Serialization;
using Spatia.Server.Hosting;

namespace Spatia.Server.Projects;

/// <summary>
/// Creates a blank project, starts from an approved environment or imports a validated document
/// </summary>
public sealed record CreateProjectRequest
{
    public Guid? OperationId
    {
        get; init;
    }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public CreationGuard? CreationGuard
    {
        get; init;
    }
    /// <summary>Gets the new project's bounded title</summary>
    public required string Title
    {
        get; init;
    }
    /// <summary>Gets optional raster imagery stored atomically with this draft</summary>
    public ProjectImageUpload? Image
    {
        get; init;
    }
    /// <summary>Gets an approved environment asset for a blank project</summary>
    public string? EnvironmentAssetId
    {
        get; init;
    }
    /// <summary>Gets the complete imported document, mutually exclusive with an environment asset</summary>
    public JsonElement? Document
    {
        get; init;
    }
    /// <summary>Gets the active organization selected by a global administrator</summary>
    public Guid? OrgId
    {
        get; init;
    }
}
