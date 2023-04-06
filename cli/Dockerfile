FROM node:19-alpine
WORKDIR /opt/ankh-bibliothek-uploader
COPY insert-build.ts /opt/ankh-bibliothek-uploader/.
COPY package.json /opt/ankh-bibliothek-uploader/.
COPY tsconfig.json /opt/ankh-bibliothek-uploader/.
RUN apk add --no-cache git && \
    npm i && \
    npx tsc && \
    chmod +x insert-build.js && \
    ln -s /opt/ankh-bibliothek-uploader/insert-build.js /usr/bin/insert-build
ENTRYPOINT /usr/bin/insert-build
