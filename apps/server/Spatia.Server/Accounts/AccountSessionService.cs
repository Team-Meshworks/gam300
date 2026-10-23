using Microsoft.AspNetCore.Identity;
using Spatia.Server.Persistence;
using Spatia.Server.Security;

namespace Spatia.Server.Accounts;

/// <summary>
/// Signs in current accounts and changes passwords using the request's Identity session
/// </summary>
/// <param name="users">The Identity manager used to verify and update credentials</param>
/// <param name="signIn">The sign-in manager bound to the current HTTP request</param>
/// <param name="database">The scoped database context shared with the Identity stores</param>
/// <param name="accounts">The resolver that checks current account authority</param>
public sealed class AccountSessionService(
    UserManager<ApplicationUser> users,
    SignInManager<ApplicationUser> signIn,
    ApplicationDbContext database,
    CurrentAccountResolver accounts)
{
    /// <summary>
    /// Verifies credentials and current account authority before issuing a nonpersistent session cookie
    /// </summary>
    /// <param name="request">The username and password to verify</param>
    /// <param name="cancellationToken">The token used to cancel account lookup and sign-in preparation</param>
    /// <returns>Success when a cookie is issued, or a generic failure without revealing account state</returns>
    /// <exception cref="OperationCanceledException">The operation is canceled</exception>
    public async Task<SignInResult> LoginAsync(LoginRequest request, CancellationToken cancellationToken = default)
    {
        if (!IsValidLoginRequest(request)
            || signIn.Context.Features.Get<CurrentAccount>() is { MustChangePassword: true })
        {
            return SignInResult.Failed;
        }

        cancellationToken.ThrowIfCancellationRequested();
        var user = await users.FindByNameAsync(request.UserName);
        if (user is null || user.TwoFactorEnabled)
        {
            return SignInResult.Failed;
        }

        cancellationToken.ThrowIfCancellationRequested();
        var result = await signIn.CheckPasswordSignInAsync(user, request.Password, lockoutOnFailure: true);
        if (!result.Succeeded || string.IsNullOrEmpty(user.SecurityStamp))
        {
            return SignInResult.Failed;
        }

        var account = await accounts.ResolveAsync(user.Id, user.SecurityStamp, cancellationToken);
        if (account is null)
        {
            return SignInResult.Failed;
        }

        cancellationToken.ThrowIfCancellationRequested();
        // Keep the verified entity so a later reset can only leave an invalid old-stamp ticket
        await signIn.SignInAsync(user, isPersistent: false);
        return SignInResult.Success;
    }

    /// <summary>
    /// Changes the current account's password, clears the required-change flag and refreshes its session
    /// </summary>
    /// <param name="request">The current password and a different replacement password</param>
    /// <param name="cancellationToken">The token used to cancel database work</param>
    /// <returns>The password change result, including validation, authentication or concurrency failures</returns>
    /// <exception cref="OperationCanceledException">The operation is canceled</exception>
    public async Task<IdentityResult> ChangePasswordAsync(
        ChangePasswordRequest request,
        CancellationToken cancellationToken = default)
    {
        if (request is null || !IsValidPassword(request.CurrentPassword) || !IsValidPassword(request.NewPassword)
            || string.Equals(request.CurrentPassword, request.NewPassword, StringComparison.Ordinal))
        {
            return Failure("PasswordChangeFailed");
        }

        var context = signIn.Context;
        var account = context.Features.Get<CurrentAccount>();
        var stamps = context.User.FindAll(signIn.Options.ClaimsIdentity.SecurityStampClaimType).ToArray();
        if (account is null || stamps.Length != 1 || string.IsNullOrEmpty(stamps[0].Value))
        {
            return Failure("AuthenticationRequired");
        }

        await using var transaction = await database.Database.BeginTransactionAsync(cancellationToken);
        var user = await users.FindByIdAsync(account.UserId.ToString("D"));
        if (user is null || user.SecurityStamp != stamps[0].Value)
        {
            await signIn.SignOutAsync();
            return Failure("AuthenticationRequired");
        }

        cancellationToken.ThrowIfCancellationRequested();
        user.MustChangePassword = false;
        var result = await users.ChangePasswordAsync(user, request.CurrentPassword, request.NewPassword);
        if (!result.Succeeded)
        {
            return result;
        }

        cancellationToken.ThrowIfCancellationRequested();
        await transaction.CommitAsync(cancellationToken);
        await signIn.RefreshSignInAsync(user);
        return IdentityResult.Success;
    }

    internal static bool IsValidLoginRequest(LoginRequest? request)
        => request is not null && request.UserName is { Length: >= 1 and <= 256 }
            && !string.IsNullOrWhiteSpace(request.UserName) && !request.UserName.Contains('\0')
            && IsValidPassword(request.Password);

    private static bool IsValidPassword(string? password) => password is { Length: >= 12 and <= 128 };

    private static IdentityResult Failure(string code)
        => IdentityResult.Failed(new IdentityError
        {
            Code = code,
            Description = "The session operation could not be completed.",
        });
}
