using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Spatia.Server.Security;

namespace Spatia.Server.Tests;

public sealed class EnvironmentCookieTests
{
    [Test]
    public async Task EnvironmentsOnDifferentPortsUseDistinctCookieNames()
    {
        var names = new HashSet<string>();
        foreach (var (environment, suffix) in new[] { ("Development", ".Development"), ("Production", ".Production"), ("Testing", "") })
        {
            var services = new ServiceCollection();
            services.AddLogging();
            services.AddSpatiaRequestSecurity(environment);
            using var provider = services.BuildServiceProvider();
            var session = provider.GetRequiredService<IOptionsMonitor<CookieAuthenticationOptions>>()
                .Get(IdentityConstants.ApplicationScheme).Cookie;
            var csrf = provider.GetRequiredService<IOptions<AntiforgeryOptions>>().Value.Cookie;
            await Assert.That(names.Add(session.Name!)).IsTrue();
            await Assert.That(names.Add(csrf.Name!)).IsTrue();
            await Assert.That(session.Name).IsEqualTo("__Host-Spatia.Application" + suffix);
            await Assert.That(csrf.Name).IsEqualTo("__Host-Spatia.Antiforgery" + suffix);
            await Assert.That(session.Path).IsEqualTo("/");
        }
    }
}
