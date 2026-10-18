namespace Spatia.Server.Accounts;

public sealed class ChangePasswordRequest
{
    public required string CurrentPassword { get; init; }

    public required string NewPassword { get; init; }
}
