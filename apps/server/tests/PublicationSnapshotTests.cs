using System.Text;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Spatia.Server.Projects;
using Format = Spatia.ProjectFormat.ProjectFormat;

namespace Spatia.Server.Tests;

public sealed partial class PublicationCoordinatorTests
{
    [Test]
    [Arguments(1, "rotation")]
    [Arguments(2, "rotation")]
    [Arguments(1, "read-limit")]
    [Arguments(1, "serialize-limit")]
    public async Task PublicationCoordinator_PreservesSavedJsonWithoutRenormalizing(int version, string scenario)
    {
        await using var fixture = await PublicationCoordinatorFixture.CreateAsync(version);
        var input = JsonNode.Parse(ProjectTestDocuments.Create(fixture.ProjectId, "Saved snapshot", version))!;
        // These saved quaternions change length or spelling on subsequent normalization passes.
        input["scenes"]![0]!["startCamera"]!["rotation"] = scenario switch
        {
            "read-limit" => new JsonArray(0.47490965438830257, -0.6980326014100272, -0.1736294030169948, -0.5070149287205405),
            "serialize-limit" => new JsonArray(0.6267845488506097, -0.36662911366558604, 0.5535539462274982, -0.4078017299508285),
            _ => new JsonArray(-0.04334603238835914, -0.4929046071223118, 0.7105726134622642, 0.5002526669106266),
        };
        if (scenario != "rotation")
        {
            var accepted = fixture.Documents.Read(fixture.ProjectId, input.ToJsonString());
            await Assert.That(accepted.Ok).IsTrue();
            var normalized = fixture.Documents.Serialize(accepted.Value!);
            await Assert.That(normalized.Ok).IsTrue();
            input["title"] = input["title"]!.GetValue<string>()
                + new string('x', Format.MaxProjectBytes - Encoding.UTF8.GetByteCount(normalized.Value!));
            await Assert.That(Encoding.UTF8.GetByteCount(input.ToJsonString())).IsEqualTo(Format.MaxProjectBytes);
        }

        await using (var database = fixture.Database())
        {
            var saver = new ProjectSaveService(database, fixture.Access(database), fixture.Documents);
            var save = await saver.SaveAsync(fixture.Context(), fixture.ProjectId,
                new ParsedSaveEnvelope(0, Guid.NewGuid(), input.ToJsonString()));
            await Assert.That(save.Acknowledgement?.Revision).IsEqualTo((long?)1);
        }
        string savedJson;
        await using (var database = fixture.Database())
        {
            savedJson = (await database.Projects.AsNoTracking().SingleAsync()).DocumentJson;
        }
        if (scenario != "rotation")
        {
            // jsonb adds whitespace; the upload byte limit must not be applied to its raw representation.
            await Assert.That(Encoding.UTF8.GetByteCount(savedJson)).IsGreaterThan(Format.MaxProjectBytes);
        }

        var request = Request(1);
        await AssertCommittedAsync(await fixture.PublishAsync(request), request, fixture.ProjectId, false);
        await Assert.That((await fixture.ReadAsync(request.PublicationId)).DocumentJson).IsEqualTo(savedJson);
        await AssertCommittedAsync(await fixture.PublishAsync(request), request, fixture.ProjectId, true);
        await Assert.That((await fixture.ReadAsync(request.PublicationId)).DocumentJson).IsEqualTo(savedJson);
        await using var observer = fixture.Database();
        var draft = await observer.Projects.AsNoTracking().SingleAsync();
        await Assert.That(draft.DocumentJson).IsEqualTo(savedJson);
        await Assert.That(draft.Revision).IsEqualTo(1);
        await fixture.AssertCountAsync(1);
    }
}
