FROM node:14

RUN mkdir /usr/src/app
WORKDIR /usr/src/app

COPY . .

ENTRYPOINT node /usr/src/app/external-request.js
