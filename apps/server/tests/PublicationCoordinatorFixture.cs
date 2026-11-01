using System.Data.Common;
using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Npgsql;
using Spatia.ProjectFormat;
using Spatia.Server.Accounts;
using Spatia.Server.Persistence;
using Spatia.Server.Projects;
using Spatia.Server.Publications;
using Spatia.Server.Security;

namespace Spatia.Server.Tests;

internal sealed class PublicationCoordinatorFixture(PostgresAccountFixture postgres, string connectionString) : IAsyncDisposable
{
    public Guid ActorId { get; } = Guid.NewGuid();
    public Guid ProjectId { get; } = Guid.NewGuid();
    public Guid OrganizationId { get; } = Guid.NewGuid();
    public string Stamp { get; } = Guid.NewGuid().ToString("N");
    public TestTimeProvider Clock { get; } = new();
    public FixturePublicationIntegration Integration { get; } = new();
    public ProjectDocumentService Documents { get; } = new(new Environment());

    public static async Task<PublicationCoordinatorFixture> CreateAsync(int version = 1,
        string role = ApplicationRoles.Creator, long revision = 0)
    {
        var postgres = await PostgresAccountFixture.CreateForApplicationAsync();
        try
        {
            await using var scope = postgres.Services.CreateAsyncScope();
            var connection = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Database.GetConnectionString()!;
            var fixture = new PublicationCoordinatorFixture(postgres, connection);
            await using var database = fixture.Database();
            database.Organizations.Add(new Organization { Id = fixture.OrganizationId, Name = "Synthetic publisher school" });
            var roleId = role switch
            {
                ApplicationRoles.Creator => ApplicationRoles.CreatorId,
                ApplicationRoles.Educator => ApplicationRoles.EducatorId,
                _ => ApplicationRoles.AdministratorId,
            };
            database.Users.Add(new ApplicationUser
            {
                Id = fixture.ActorId,
                UserName = "publisher",
                NormalizedUserName = "PUBLISHER",
                SecurityStamp = fixture.Stamp,
                MustChangePassword = false,
            });
            database.UserRoles.Add(new IdentityUserRole<Guid> { UserId = fixture.ActorId, RoleId = roleId });
            if (role != ApplicationRoles.Administrator)
            {
                database.OrganizationMemberships.Add(new OrganizationMembership
                {
                    UserId = fixture.ActorId,
                    OrganizationId = fixture.OrganizationId,
                    RoleId = roleId,
                });
            }
            database.Projects.Add(new Project
            {
                Id = fixture.ProjectId,
                OrganizationId = fixture.OrganizationId,
                Revision = revision,
                SchemaVersion = version,
                DocumentJson = ProjectTestDocuments.Create(fixture.ProjectId, "Chosen edition", version),
                UpdatedAt = DateTimeOffset.UnixEpoch,
            });
            if (role != ApplicationRoles.Administrator)
            {
                database.ProjectAssignments.Add(new ProjectAssignment
                {
                    ProjectId = fixture.ProjectId,
                    UserId = fixture.ActorId,
                    CanEdit = true,
                    CanManage = role == ApplicationRoles.Educator,
                    CanPublish = role == ApplicationRoles.Creator,
                });
            }
            await database.SaveChangesAsync();
            return fixture;
        }
        catch { await postgres.DisposeAsync(); throw; }
    }

    public ApplicationDbContext Database(params IInterceptor[] interceptors) => new(
        new DbContextOptionsBuilder<ApplicationDbContext>().UseNpgsql(connectionString).AddInterceptors(interceptors).Options);

    public HttpContext Context(Guid? actorId = null)
    {
        var id = actorId ?? ActorId;
        var context = new DefaultHttpContext
        {
            User = new ClaimsPrincipal(new ClaimsIdentity([
                new Claim(ClaimTypes.NameIdentifier, id.ToString("D")),
                new Claim("AspNet.Identity.SecurityStamp", Stamp),
                new Claim(ClaimTypes.Role, ApplicationRoles.Administrator), // Deliberately forged; DB determines authority.
            ], "fixture")),
        };
        context.Features.Set(new ValidatedAccountSession(id, Stamp, Clock.GetUtcNow().AddHours(1), Clock));
        return context;
    }

    public ProjectAccessService Access(ApplicationDbContext database) =>
        new(database, new CurrentAccountResolver(database), Options.Create(new IdentityOptions()));

    public PublicationCoordinator Coordinator(ApplicationDbContext database, bool unavailable = false) =>
        new(database, Access(database), Documents, unavailable ? null : Integration);

    public async Task<PublicationResult> PublishAsync(PublicationRequest request, HttpContext? context = null,
        Guid? projectId = null, bool unavailable = false)
    {
        await using var database = Database();
        return await Coordinator(database, unavailable).PublishAsync(context ?? Context(), projectId ?? ProjectId, request);
    }

    public async Task<Publication> ReadAsync(Guid id)
    {
        await using var database = Database();
        return await database.Publications.AsNoTracking().SingleAsync(row => row.Id == id);
    }

    public async Task AssertCountAsync(int count)
    {
        await using var database = Database();
        await Assert.That(await database.Publications.CountAsync()).IsEqualTo(count);
    }

    public async Task WaitBlockedAsync(int waiter, int blocker)
    {
        await using var observer = Database();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        while (!await observer.Database.SqlQuery<bool>($"SELECT {blocker} = ANY(pg_blocking_pids({waiter})) AS \"Value\"")
            .SingleAsync(timeout.Token))
        {
            await Task.Delay(10, timeout.Token);
        }
    }

    public ValueTask DisposeAsync() => postgres.DisposeAsync();

    private sealed class Environment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Development";
        public string ApplicationName { get; set; } = "publication-fixture";
        public string ContentRootPath { get; set; } = AppContext.BaseDirectory;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}

// These gates deliberately represent test decisions, not a class/approval/catalogue/audience implementation.
internal sealed class FixturePublicationIntegration : IPublicationIntegration
{
    public static readonly string[] Capabilities = ["multipleScenes", "visibility", "content:hotspot", "content:text",
        "content:image", "content:audio", "content:video", "content:navigationPoint", "audio:ambient", "audio:spatial",
        "text:bold", "text:italic", "text:underline", "trigger:click", "trigger:zoneEnter", "trigger:sceneStart",
        "trigger:elapsed", "trigger:gaze", "trigger:panelClose", "action:showPanel", "action:playMedia",
        "action:moveCamera", "action:setVisible", "action:navigateScene", "action:openLink"];

    public PublicationRejection? PreparationFailure;
    public PublicationRejection? ReplayFailure;
    public PublicationRejection? StageFailure;
    public string[] RuntimeCapabilities = Capabilities;
    public bool OrdinaryOriginVerified = true;
    public Func<PublicationAssetReference[], PublicationAssetReference[]>? ChangeReferences;
    public Func<ApplicationDbContext, Task>? BeforePrepare;
    public Func<ApplicationDbContext, Task>? OnStage;
    public int Preparations;
    public int Replays;
    public int Stages;

    public async Task<PublicationPreparation> PrepareAsync(ApplicationDbContext database, ProjectAccessSnapshot project,
        PublicationRequest request, IAuthoredProject document, CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref Preparations);
        await Assert.That(database.Database.CurrentTransaction is not null).IsTrue();
        await Assert.That(project.Revision).IsEqualTo(request.ConfirmedRevision);
        if (BeforePrepare is { } before) { await before(database); }
        if (PreparationFailure is { } failure) { return PublicationPreparation.Denied(failure); }
        var references = PublicationDocumentAssets.Required(document)
            .Select(id => new PublicationAssetReference(id, new string('a', 64))).ToArray();
        return PublicationPreparation.Ready(ChangeReferences?.Invoke(references) ?? references, RuntimeCapabilities, OrdinaryOriginVerified);
    }

    public Task<PublicationRejection?> AuthorizeReplayAsync(ApplicationDbContext database, ProjectAccessSnapshot project,
        PublicationRequest request, Publication edition, CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref Replays);
        return Task.FromResult(ReplayFailure);
    }

    public async Task<PublicationRejection?> StageAsync(ApplicationDbContext database, ProjectAccessSnapshot project,
        PublicationRequest request, Publication edition, CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref Stages);
        if (OnStage is { } stage) { await stage(database); }
        return StageFailure;
    }
}

internal sealed class PublicationCommitProbe : DbTransactionInterceptor
{
    public Func<DbTransaction, CancellationToken, Task>? Before;
    public Action? After;

    public override async ValueTask<InterceptionResult> TransactionCommittingAsync(DbTransaction transaction,
        TransactionEventData eventData, InterceptionResult result, CancellationToken cancellationToken = default)
    {
        if (Interlocked.Exchange(ref Before, null) is { } before) { await before(transaction, cancellationToken); }
        return result;
    }

    public override Task TransactionCommittedAsync(DbTransaction transaction, TransactionEndEventData eventData,
        CancellationToken cancellationToken = default)
    {
        Interlocked.Exchange(ref After, null)?.Invoke();
        return Task.CompletedTask;
    }
}
