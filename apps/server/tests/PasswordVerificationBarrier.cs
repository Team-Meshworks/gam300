using Microsoft.AspNetCore.Identity;
using Spatia.Server.Accounts;

namespace Spatia.Server.Tests;

internal sealed class PasswordVerificationBarrier : IPasswordHasher<ApplicationUser>
{
    private readonly PasswordHasher<ApplicationUser> _inner = new();
    private Guid _target;
    private int _armed;

    public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public void Arm(Guid target)
    {
        _target = target;
        Interlocked.Exchange(ref _armed, 1);
    }

    public string HashPassword(ApplicationUser user, string password) => _inner.HashPassword(user, password);

    public PasswordVerificationResult VerifyHashedPassword(ApplicationUser user, string hashedPassword, string providedPassword)
    {
        var result = _inner.VerifyHashedPassword(user, hashedPassword, providedPassword);
        if (result != PasswordVerificationResult.Failed && user.Id == _target
            && Interlocked.CompareExchange(ref _armed, 0, 1) == 1)
        {
            Entered.TrySetResult();
            Release.Task.WaitAsync(TimeSpan.FromSeconds(15)).GetAwaiter().GetResult();
        }
        return result;
    }
}
