namespace Spatia.ProjectFormat;

// Authored content carries no account authority or server revision
public interface IAuthoredProject
{
    int SchemaVersion { get; }
    string ProjectId { get; }
    string Title { get; }
}
