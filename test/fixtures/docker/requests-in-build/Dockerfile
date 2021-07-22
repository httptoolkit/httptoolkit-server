# Run a series of HTTPS requests during the build, from different multistage builds.
# Can HTTP Toolkit successfully hook the build and capture all of these?
FROM node:14 as BASE
RUN curl https://base-request.test

FROM node:14 as BASE2
COPY . .
RUN curl https://base2-request.test

FROM BASE
COPY --from=BASE2 make-request.js .
RUN node ./make-request.js https://final-stage-request.test