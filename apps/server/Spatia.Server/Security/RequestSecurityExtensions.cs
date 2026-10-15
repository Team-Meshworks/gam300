using System.Globalization;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection;
using Spatia.Server.Accounts;
using Spatia.Server.Hosting;

namespace Spatia.Server.Security;

public static class RequestSecurityExtensions
{
    public static IServiceCollection AddSpatiaRequestSecurity(this IServiceCollection services)
    {
        services.AddIdentityCore<ApplicationUser>().AddSignInManager()
            .AddTokenProvider<DataProtectorTokenProvider<ApplicationUser>>(TokenOptions.DefaultProvider);
        services.AddAuthentication(options =>
        {
            options.DefaultAuthenticateScheme = IdentityConstants.ApplicationScheme;
            options.DefaultChallengeScheme = IdentityConstants.ApplicationScheme;
            options.DefaultSignInScheme = IdentityConstants.ExternalScheme;
        }).AddIdentityCookies();
        services.AddScoped<CurrentAccountCookieEvents>();
        services.ConfigureApplicationCookie(options =>
        {
            options.Cookie.Name = "__Host-Spatia.Application";
            options.Cookie.Path = "/";
            options.Cookie.HttpOnly = true;
            options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
            options.Cookie.SameSite = SameSiteMode.Lax;
            options.Cookie.MaxAge = null;
            options.ExpireTimeSpan = TimeSpan.FromHours(8);
            options.SlidingExpiration = false;
            options.EventsType = typeof(CurrentAccountCookieEvents);
        });
        services.Configure<SecurityStampValidatorOptions>(options =>
            options.ValidationInterval = TimeSpan.FromMinutes(5));
        services.Configure<IdentityOptions>(options =>
        {
            options.Password.RequiredLength = 12;
            options.Password.RequireDigit = false;
            options.Password.RequireLowercase = false;
            options.Password.RequireUppercase = false;
            options.Password.RequireNonAlphanumeric = false;
            options.Lockout.AllowedForNewUsers = true;
            options.Lockout.MaxFailedAccessAttempts = 5;
            options.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(5);
        });
        services.AddScoped<IPasswordValidator<ApplicationUser>, MaximumPasswordLengthValidator>();
        services.AddAntiforgery(options =>
        {
            options.HeaderName = "X-CSRF-TOKEN";
            options.Cookie.Name = "__Host-Spatia.Antiforgery";
            options.Cookie.Path = "/";
            options.Cookie.HttpOnly = true;
            options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
            options.Cookie.SameSite = SameSiteMode.Lax;
        });
        services.AddAuthorization(options =>
        {
            var fullAccount = new AuthorizationPolicyBuilder(IdentityConstants.ApplicationScheme)
                .RequireAuthenticatedUser()
                .RequireAssertion(context => GetCurrentAccount(context) is { MustChangePassword: false })
                .Build();
            options.AddPolicy(SecurityPolicies.FullAccount, fullAccount);
            options.DefaultPolicy = fullAccount;
            options.FallbackPolicy = fullAccount;
            options.AddPolicy(SecurityPolicies.CurrentAccount, policy => policy
                .AddAuthenticationSchemes(IdentityConstants.ApplicationScheme)
                .RequireAuthenticatedUser()
                .RequireAssertion(context => GetCurrentAccount(context) is { } account
                    && (!account.MustChangePassword || IsForcedSessionRoute(context.Resource as HttpContext))));
            options.AddPolicy(SecurityPolicies.Administrator, new AuthorizationPolicyBuilder(fullAccount)
                .RequireRole(ApplicationRoles.Administrator).Build());
        });
        services.AddRateLimiter(options =>
        {
            options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(_ =>
                RateLimitPartition.GetConcurrencyLimiter("application", _ => new ConcurrencyLimiterOptions
                {
                    PermitLimit = 64,
                    QueueLimit = 0,
                }));
            options.AddPolicy(SecurityPolicies.AuthenticationRateLimit, context =>
                RateLimitPartition.GetFixedWindowLimiter(GetIpKey(context), _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = 60,
                    Window = TimeSpan.FromMinutes(1),
                    QueueLimit = 0,
                }));
            options.AddPolicy(SecurityPolicies.AccountWriteRateLimit, context =>
                RateLimitPartition.GetFixedWindowLimiter(
                    context.Features.Get<CurrentAccount>() is { } account
                        ? "user:" + account.UserId.ToString("D")
                        : GetIpKey(context),
                    _ => new FixedWindowRateLimiterOptions
                    {
                        PermitLimit = 20,
                        Window = TimeSpan.FromMinutes(1),
                        QueueLimit = 0,
                    }));
            options.OnRejected = async (context, cancellationToken) =>
            {
                var seconds = context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter)
                    ? Math.Max(1, (int)Math.Ceiling(retryAfter.TotalSeconds))
                    : 1;
                context.HttpContext.Response.Headers.RetryAfter = seconds.ToString(CultureInfo.InvariantCulture);
                await ApiProblems.Create(context.HttpContext, 429, "rate_limited", "Please retry later.")
                    .ExecuteAsync(context.HttpContext);
            };
        });
        return services;
    }

    public static IApplicationBuilder UseSpatiaAntiforgery(this IApplicationBuilder app)
        => app.UseMiddleware<CsrfGuardMiddleware>();

    private static CurrentAccount? GetCurrentAccount(AuthorizationHandlerContext context)
        => (context.Resource as HttpContext)?.Features.Get<CurrentAccount>();

    private static bool IsForcedSessionRoute(HttpContext? context)
    {
        if (context is null)
        {
            return false;
        }

        return HttpMethods.IsGet(context.Request.Method)
            ? context.Request.Path.Equals("/api/auth/csrf", StringComparison.OrdinalIgnoreCase)
                || context.Request.Path.Equals("/api/auth/session", StringComparison.OrdinalIgnoreCase)
            : HttpMethods.IsPost(context.Request.Method)
                && (context.Request.Path.Equals("/api/auth/password", StringComparison.OrdinalIgnoreCase)
                    || context.Request.Path.Equals("/api/auth/logout", StringComparison.OrdinalIgnoreCase));
    }

    private static string GetIpKey(HttpContext context)
        => "ip:" + (context.Connection.RemoteIpAddress?.ToString() ?? "unknown");
}
