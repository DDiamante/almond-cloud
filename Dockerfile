FROM node:10.18.0-jessie

RUN apt-get update
RUN apt-get install -y git

RUN yarn global add github:stanford-oval/almond-cloud
RUN yarn