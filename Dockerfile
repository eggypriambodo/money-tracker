# Build dependencies
FROM node:18-alpine as dependencies
WORKDIR /app
COPY package.json .
RUN npm i
COPY . . 
# Build production image
FROM dependencies as builder
EXPOSE 3000
CMD npm run start