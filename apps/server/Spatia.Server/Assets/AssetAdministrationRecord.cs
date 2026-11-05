namespace Spatia.Server.Assets;

/// <summary>Exposes safe administrative metadata without returning upload bytes or submitter credentials</summary>
public sealed record AssetAdministrationRecord(Guid Id, string Name, string Kind, string? Category,
    string Status, bool Hidden, bool Deleted, bool RemovedFromProjects, string? Thumbnail,
    string[] Validation, string[] Actions, string Sha256, string? Source, string? License, string? ReviewNotes, string InspectionUrl);
