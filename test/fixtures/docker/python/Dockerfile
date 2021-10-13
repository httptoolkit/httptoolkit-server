FROM python:3.9-slim

RUN mkdir /usr/src/app
WORKDIR /usr/src/app

RUN pip install requests

COPY . .

ENTRYPOINT ["python", "/usr/src/app/app.py"]