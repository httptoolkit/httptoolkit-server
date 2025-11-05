FROM eclipse-temurin:24-alpine

RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

# We run the app with a non-root user, because this is a common pattern especially
# in Java apps, and we need to ensure the injected file permissions support it:
RUN adduser --uid 5000 -D appuser && chown -R appuser /usr/src/app
USER appuser

COPY . .

RUN javac Main.java

ENTRYPOINT ["java", "Main"]