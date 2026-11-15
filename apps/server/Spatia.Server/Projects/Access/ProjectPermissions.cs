namespace Spatia.Server.Projects;

/// <summary>
/// Describes effective presentation permissions; subsequent operations recheck authority at the server
/// </summary>
public sealed record ProjectPermissions(bool CanEdit, bool CanManage, bool CanPublish);
