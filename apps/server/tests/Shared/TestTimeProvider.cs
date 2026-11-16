namespace Spatia.Server.Tests;

internal sealed class TestTimeProvider : TimeProvider
{
    private long _utcTicks = new DateTimeOffset(2026, 10, 14, 12, 0, 0, TimeSpan.Zero).UtcTicks;
    private long _stepTicks;

    public override DateTimeOffset GetUtcNow()
    {
        var step = Interlocked.Read(ref _stepTicks);
        return new DateTimeOffset(step == 0 ? Interlocked.Read(ref _utcTicks) : Interlocked.Add(ref _utcTicks, step), TimeSpan.Zero);
    }

    public void Advance(TimeSpan duration) => Interlocked.Add(ref _utcTicks, duration.Ticks);

    public void Set(DateTimeOffset instant) => Interlocked.Exchange(ref _utcTicks, instant.UtcTicks);

    public void AdvanceOnRead(TimeSpan step) => Interlocked.Exchange(ref _stepTicks, step.Ticks);
}
