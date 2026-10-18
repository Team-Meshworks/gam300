namespace Spatia.Server.Security;

internal sealed record ValidatedAccountSession(
    Guid UserId,
    string SecurityStamp,
    DateTimeOffset ExpiresUtc,
    TimeProvider Clock);
