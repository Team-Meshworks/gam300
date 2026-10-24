namespace Spatia.Server.Security;

/// <summary>
/// Defines the registered authorization and rate limiting policy names
/// </summary>
public static class SecurityPolicies
{
    /// <summary>
    /// Requires a current authenticated account with no pending mandatory password change
    /// </summary>
    public const string FullAccount = "FullAccount";

    /// <summary>
    /// Allows current accounts, restricting mandatory-password-change sessions to approved session routes
    /// </summary>
    public const string CurrentAccount = "CurrentAccount";

    /// <summary>
    /// Requires full account access and the administrator role
    /// </summary>
    public const string Administrator = "Administrator";

    /// <summary>
    /// Identifies the per-IP authentication request rate limit
    /// </summary>
    public const string AuthenticationRateLimit = "Authentication";

    /// <summary>
    /// Identifies the account write rate limit partitioned by current account or remote IP
    /// </summary>
    public const string AccountWriteRateLimit = "AccountWrite";
}
