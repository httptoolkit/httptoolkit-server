# Run a series of HTTPS requests during the build, from different multistage builds.
# Can HTTP Toolkit successfully hook the build and capture all of these?
FROM node:14 as base-image
RUN curl -s https://base-request.test

FROM node:14 as base-image-2
COPY . .
RUN curl -s https://base2-request.test

FROM base-image
COPY --from=base-image-2 make-request.js .
RUN node ./make-request.js https://final-stage-request.test