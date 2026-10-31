using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Spatia.Server.Accounts;

namespace Spatia.Server.Tests;

internal sealed class AccountSaveBarrierInterceptor(EntityState state) : SaveChangesInterceptor
{
    private readonly TaskCompletionSource _bothArrived = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int _arrivals;
    private int _armed;

    public void Arm() => Interlocked.Exchange(ref _armed, 1);

    public override async ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData eventData,
        InterceptionResult<int> result, CancellationToken cancellationToken = default)
    {
        if (Volatile.Read(ref _armed) == 1 && eventData.Context is { } context
            && context.ChangeTracker.Entries<ApplicationUser>().Any(entry => entry.State == state))
        {
            if (Interlocked.Increment(ref _arrivals) == 2)
            {
                Interlocked.Exchange(ref _armed, 0);
                _bothArrived.TrySetResult();
            }
            await _bothArrived.Task.WaitAsync(TimeSpan.FromSeconds(10), cancellationToken);
        }
        return result;
    }
}
