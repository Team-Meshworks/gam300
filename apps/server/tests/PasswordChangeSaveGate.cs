using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Spatia.Server.Accounts;

namespace Spatia.Server.Tests;

internal sealed class PasswordChangeSaveGate : SaveChangesInterceptor
{
    private Guid _target;
    private int _armed;

    public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public void Arm(Guid target)
    {
        _target = target;
        Interlocked.Exchange(ref _armed, 1);
    }

    public override async ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData eventData,
        InterceptionResult<int> result, CancellationToken cancellationToken = default)
    {
        if (eventData.Context is { } context && context.ChangeTracker.Entries<ApplicationUser>().Any(entry =>
            entry.State == EntityState.Modified && entry.Entity.Id == _target && !entry.Entity.MustChangePassword)
            && Interlocked.CompareExchange(ref _armed, 0, 1) == 1)
        {
            Entered.TrySetResult();
            await Release.Task.WaitAsync(TimeSpan.FromSeconds(15), cancellationToken);
        }
        return result;
    }
}
