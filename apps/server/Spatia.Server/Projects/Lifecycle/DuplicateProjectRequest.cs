using System.Text.Json.Serialization;
using Spatia.Server.Hosting;

namespace Spatia.Server.Projects;

/// <summary>Copies a specific authorized source revision into a separately owned draft</summary>
public sealed record DuplicateProjectRequest
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
    /// <summary>Gets the source revision the caller intends to duplicate</summary>
    [JsonNumberHandling(JsonNumberHandling.Strict)]
    public required long ExpectedRevision
    {
        get; init;
    }
    /// <summary>Gets the new project's bounded title</summary>
    public required string Title
    {
        get; init;
    }
}
