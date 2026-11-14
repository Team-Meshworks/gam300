namespace Spatia.Server.Projects;

/// <summary>Retains private immutable cover bytes shared by a source and its independent draft copies</summary>
public sealed class ProjectImage
{
    public Guid Id { get; set; }
    public required string Type { get; set; }
    public required string ContentType { get; set; }
    public required byte[] Data { get; set; }
}

/// <summary>Accepts a bounded image inside the existing atomic project creation request</summary>
public sealed record ProjectImageUpload(string Type, string ContentType, byte[] Data);

/// <summary>Exposes a permission-checked image route without disclosing its storage identity</summary>
public sealed record ProjectImageMetadata(string Type, string Url);
