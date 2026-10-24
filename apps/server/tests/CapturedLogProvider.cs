using System.Collections.Concurrent;
using Microsoft.Extensions.Logging;

namespace Spatia.Server.Tests;

internal sealed class CapturedLogProvider : ILoggerProvider
{
    private readonly ConcurrentQueue<string> _messages = new();

    public string Messages => string.Join('\n', _messages);

    public ILogger CreateLogger(string categoryName) => new CapturedLogger(_messages);

    public void Dispose()
    {
    }

    private sealed class CapturedLogger(ConcurrentQueue<string> messages) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            messages.Enqueue(formatter(state, exception));
            if (exception is not null)
            {
                messages.Enqueue(exception.ToString());
            }
        }
    }
}
