# API container image, built by every cloud's CI/CD
# (buildspec.yml / cloudbuild.yaml / azure-pipelines.yml).
# NODE_IMAGE lets a build use a mirror of the same image
# (e.g. public.ecr.aws/docker/library/node on AWS).
# APP_VERSION is the commit being built, returned by the health endpoints.
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json jest.config.js ./
COPY src ./src
COPY models ./models
COPY generated ./generated
COPY migrations ./migrations
COPY __tests__ ./__tests__
# A failing test fails the build, so no cloud deploys an untested image.
# The tests also check that the migrations and generated/ are up to date.
RUN npm test
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Model definitions, read at startup (src/models/load.ts).
COPY models ./models
# Migration names, checked by /readyz (src/migrations.ts).
COPY migrations ./migrations
ARG APP_VERSION=unknown
ENV APP_VERSION=${APP_VERSION}
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
