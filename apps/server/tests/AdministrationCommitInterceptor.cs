using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace Spatia.Server.Tests;

internal sealed class AdministrationCommitInterceptor : DbTransactionInterceptor
{
    private int _armed;
    private CancellationTokenSource? _cancellation;

    public void Arm(CancellationTokenSource? cancellation = null)
    {
        _cancellation = cancellation;
        Interlocked.Exchange(ref _armed, 1);
    }

    public override ValueTask<InterceptionResult> TransactionCommittingAsync(DbTransaction transaction,
        TransactionEventData eventData, InterceptionResult result, CancellationToken cancellationToken = default)
    {
        if (Interlocked.Exchange(ref _armed, 0) == 1)
        {
            _cancellation?.Cancel();
            _cancellation?.Token.ThrowIfCancellationRequested();
            throw new InvalidOperationException(HttpsApplicationFixture.SecretSentinel);
        }
        return ValueTask.FromResult(result);
    }
}
