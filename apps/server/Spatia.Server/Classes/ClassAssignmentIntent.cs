using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Spatia.Server.Projects;

namespace Spatia.Server.Classes;

internal sealed record ClassAssignmentRequest(Guid? RequestId, Guid? SourceProjectId,
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] long? SourceRevision,
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] long? DueAtUnixSeconds,
    string? Title, string? Description, string? Instructions, Guid[]? StudentIds);

internal static class ClassAssignmentIntent
{
    internal const int MaximumStudents = 20;

    internal static bool IsValid(ClassAssignmentRequest request) =>
        request.RequestId is { } requestId && requestId != Guid.Empty
        && request.SourceProjectId is { } sourceId && sourceId != Guid.Empty
        && request.SourceRevision is >= 0 and <= Project.MaxRevision
        && request.DueAtUnixSeconds is >= ClassAssignment.MinimumUnixSeconds and <= ClassAssignment.MaximumUnixSeconds
        && request.Title is { Length: <= 256 } && ValidText(request.Title)
        && ValidText(request.Description) && ValidText(request.Instructions)
        && request.StudentIds is { Length: >= 1 and <= MaximumStudents } students
        && !students.Contains(Guid.Empty) && students.Distinct().Count() == students.Length;

    internal static byte[] Digest(ClassAssignmentRequest request, Guid classroomId, Guid actorId)
    {
        if (!IsValid(request) || classroomId == Guid.Empty || actorId == Guid.Empty)
        {
            throw new ArgumentException("A validated assignment request and current class and actor are required.");
        }
        return SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new
        {
            version = 1,
            classroomId,
            actorId,
            request.RequestId,
            request.SourceProjectId,
            request.SourceRevision,
            request.DueAtUnixSeconds,
            request.Title,
            request.Description,
            request.Instructions,
            studentIds = request.StudentIds!.Order().ToArray(),
        }));
    }

    private static bool ValidText(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Contains('\0')) { return false; }
        for (var index = 0; index < value.Length; index++)
        {
            if (char.IsHighSurrogate(value[index]))
            {
                if (++index >= value.Length || !char.IsLowSurrogate(value[index])) { return false; }
            }
            else if (char.IsLowSurrogate(value[index])) { return false; }
        }
        return true;
    }
}
