# API container image, built by every cloud's CI/CD
# (buildspec.yml / cloudbuild.yaml / azure-pipelines.yml).
# NODE_IMAGE lets a build use a mirror of the same image
# (e.g. public.ecr.aws/docker/library/node on AWS).
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
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
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
