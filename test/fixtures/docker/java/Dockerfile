FROM openjdk:16-alpine3.13

RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

COPY . .

RUN javac Main.java

ENTRYPOINT ["java", "Main"]