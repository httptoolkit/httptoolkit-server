FROM golang:1.16

RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

COPY . .

RUN go build app.go

ENTRYPOINT ["./app"]