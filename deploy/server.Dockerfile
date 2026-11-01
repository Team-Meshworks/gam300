# Install the existing validator from the shared lockfile without running package scripts
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS asset-validation
WORKDIR /src/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm install --global npm@11.17.0 && npm ci --ignore-scripts --no-audit --no-fund

# Match the backend's global.json; keep migrations separate from the running API
FROM mcr.microsoft.com/dotnet/sdk:10.0.401@sha256:e70cdb7f80b0348f5cb85f19a8f670fca061f033d57eed12fa003d58b0e06317 AS build
WORKDIR /src/apps/server
COPY apps/server/ ./
# The server embeds the reviewed catalogue at compile time
COPY assets/manifest.json /src/assets/manifest.json
# Package the bounded worker and its locked parser in the paths expected by the API project
COPY tools/validate-intake.mjs tools/asset-content-validation.mjs /src/tools/
COPY --from=asset-validation /src/apps/web/node_modules/gltf-validator/ /src/apps/web/node_modules/gltf-validator/
RUN dotnet restore tests/Spatia.Server.Tests.csproj --locked-mode \
    && dotnet tool restore \
    && dotnet build tests/Spatia.Server.Tests.csproj -c Release --no-restore \
    && dotnet publish Spatia.Server/Spatia.Server.csproj -c Release --no-restore -o /out

# Run once before the API starts; a failed migration must stop startup
# The existing design-time factory reads ConnectionStrings__Spatia
FROM build AS migrations
ENTRYPOINT ["dotnet", "ef", "database", "update", "--project", "Spatia.Server", "--startup-project", "tests", "--configuration", "Release", "--no-build"]

FROM mcr.microsoft.com/dotnet/aspnet:10.0.12@sha256:222759b391a1aaf241166672c8f99b2d4ada452e7b5319f3c6e8f265a37b5ad4 AS api
WORKDIR /app
COPY --from=build /out/ ./
# Execute only the fixed packaged worker; uploaded content is supplied over bounded stdin
COPY --from=asset-validation /usr/local/bin/node /usr/local/bin/node
RUN node --version
# Docker seeds a fresh volume with this directory's ownership
# Existing volumes keep their keys across container replacement
RUN mkdir -p /var/lib/spatia/keys && chown -R app:app /var/lib/spatia && chmod 700 /var/lib/spatia/keys
ENV ASPNETCORE_HTTP_PORTS=8080
USER app
EXPOSE 8080
ENTRYPOINT ["dotnet", "Spatia.Server.dll"]
