namespace Spatia.Server.Assets;

/// <summary>Retains one immutable upload and its administrative lifecycle</summary>
public sealed class AssetCandidate
{
    // Keep stable version identity and bytes together; retirement never replaces these fields
    public Guid Id { get; set; }
    public required string Name { get; set; }
    public required string Kind { get; set; }
    public string? Category { get; set; }
    public required string Sha256 { get; set; }
    public required byte[] Bytes { get; set; }

    // Pending and invalid uploads stay private until an explicit review changes availability
    public required string Status { get; set; }
    public required string ValidationJson { get; set; }
    public bool Hidden { get; set; } = true;
    public bool Deleted { get; set; }
    public bool RemovedFromProjects { get; set; }

    // Approval records identify the human decision separately from technical validation
    public string? Source { get; set; }
    public string? License { get; set; }
    public string? ReviewNotes { get; set; }

    // Retain the submitting and reviewing identities when an asset leaves the active library
    public Guid SubmittedBy { get; set; }
    public Guid? ReviewedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}
