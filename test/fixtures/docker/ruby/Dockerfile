FROM ruby:alpine3.13

RUN mkdir /usr/src/app
WORKDIR /usr/src/app

COPY . .

ENTRYPOINT ["ruby", "/usr/src/app/app.rb"]