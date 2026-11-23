namespace Spatia.Server.Tests;

internal sealed class PrincipalCreationGate
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

    public async Task PauseAsync(Guid userId)
    {
        if (userId == _target && Interlocked.CompareExchange(ref _armed, 0, 1) == 1)
        {
            Entered.TrySetResult();
            await Release.Task.WaitAsync(TimeSpan.FromSeconds(15));
        }
    }
}
