namespace Spatia.Server.Accounts;

public sealed class ResetAccountPasswordRequest
{
    public required string NewTemporaryPassword { get; init; }
}
