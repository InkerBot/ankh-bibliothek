#!/usr/bin/env node

import * as fs from "fs";
import {glob, GlobOptions, GlobOptionsWithFileTypesFalse, GlobOptionsWithFileTypesTrue} from "glob";
import {MongoClient} from "mongodb";
import gitlog from "gitlog";
import * as crypto from "crypto";

type BuildChannel = "DEFAULT" | "EXPERIMENTAL"

interface DownloadConfig {
  path:string,
  glob:GlobOptions|undefined,

  type:string,
  name:string,
}

interface InsertConfig{
  mongodbUrl:string,
  repoUsername:string,
  repoPassword:string,

  projectName:string,
  projectFriendlyName:string,
  versionGroupName:string,
  versionName:string,
  buildNumber:number,
  buildChannel:BuildChannel,
  repositoryPath:string,
  downloads:DownloadConfig[],
}

interface Closeable{
  close():any
}
async function run():Promise<number> {
  const finallyList:Closeable[] = []
  try {
    const config: InsertConfig = JSON.parse(fs.readFileSync("ankh-bibliothek.json", "utf-8"))

    process.env.MONGODB_URL ? (config.mongodbUrl = process.env.MONGODB_URL) : ""
    process.env.REPO_USERNAME ? (config.repoUsername = process.env.REPO_USERNAME) : ""
    process.env.REPO_PASSWORD ? (config.repoPassword = process.env.REPO_PASSWORD) : ""
    process.env.PROJECT_NAME ? (config.projectName = process.env.PROJECT_NAME) : ""
    process.env.PROJECT_FRIENDLY_NAME ? (config.projectFriendlyName = process.env.PROJECT_FRIENDLY_NAME) : ""
    process.env.VERSION_GROUP_NAME ? (config.versionName = process.env.VERSION_GROUP_NAME) : ""
    process.env.VERSION_NAME ? (config.versionName = process.env.VERSION_NAME) : ""
    process.env.BUILD_NUMBER ? (config.buildNumber = parseInt(process.env.BUILD_NUMBER)) : ""
    process.env.BUILD_CHANNEL ? (config.buildChannel = process.env.BUILD_CHANNEL as BuildChannel) : ""
    process.env.REPOSITORY_PATH ? (config.repositoryPath = process.env.REPOSITORY_PATH) : ""

    const downloadsPath = config.projectName + "/" + config.versionName + "/" + config.buildNumber

    const buildDownloads: any = {}
    for (const downloadConfig of config.downloads) {
      const globOptions: GlobOptionsWithFileTypesTrue = downloadConfig.glob
        ? downloadConfig.glob as GlobOptionsWithFileTypesTrue
        : {withFileTypes: true}
      globOptions.nodir = true
      globOptions.withFileTypes = true
      const matchedPaths = await glob(downloadConfig.path, globOptions)
      if (matchedPaths.length !== 1) {
        console.log(matchedPaths)
        throw new Error("matched too much paths")
      }
      const matchedPath = matchedPaths[0]
      console.log("matched path", matchedPath.fullpath())

      let fileName = config.projectName + "-" + config.versionName + "-" + config.buildNumber
      if (downloadConfig.name.indexOf(".") == -1) {
        fileName += "." + downloadConfig.name
      } else {
        fileName += "-" + downloadConfig.name
      }

      const buff = fs.readFileSync(matchedPath.fullpath());
      const digest = crypto.createHash("sha256").update(buff).digest("hex")

      const targetPath = downloadsPath + "/" + fileName

      console.log("push to ", "https://s0.blobs.inksnow.org/build/" + targetPath)
      const uploadResponse = await fetch("https://s0.blobs.inksnow.org/build/" + targetPath, {
        method: "PUT",
        body: fs.readFileSync(matchedPath.fullpath()),
        headers: {
          "content-type": "application/octet-stream",
          "authorization": "Basic " + Buffer.from(config.repoUsername + ":" + config.repoPassword).toString("base64"),
        }
      })
      if(!uploadResponse.ok){
        throw new Error("Failed to upload response, server returns " + uploadResponse.status + (await uploadResponse.text()))
      }
      buildDownloads[downloadConfig.type.replace(".", ":")] = {
        name: fileName,
        sha256: digest
      }
    }

    const client = new MongoClient(config.mongodbUrl, {
      useUnifiedTopology: true
    } as any);
    finallyList.push(client)
    await client.connect()
    const database = client.db("library")
    const project = await database.collection("projects").findOneAndUpdate(
      {name: config.projectName},
      {
        $setOnInsert: {
          name: config.projectName,
          friendlyName: config.projectFriendlyName
        }
      },
      {
        new: true,
        returnDocument: "after",
        upsert: true
      } as any
    )
    const versionGroup = await database.collection("version_groups").findOneAndUpdate(
      {project: project.value!._id, name: config.versionGroupName},
      {
        $setOnInsert: {
          project: project.value!._id,
          name: config.versionGroupName
        }
      },
      {
        new: true,
        returnDocument: "after",
        upsert: true
      } as any
    )
    const version = await database.collection("versions").findOneAndUpdate(
      {project: project.value!._id, name: config.versionName},
      {
        $setOnInsert: {
          project: project.value!._id,
          group: versionGroup.value!._id,
          name: config.versionName
        }
      },
      {
        new: true,
        returnDocument: "after",
        upsert: true
      } as any
    )
    const oldBuild = await database.collection("builds").findOne({
      project: project.value!._id,
      version: version.value!._id
    }, {sort: {_id: -1}})
    let changes: {
      commit: string,
      summary: string,
      message: string
    }[] = []
    const lastBuild = oldBuild && oldBuild.changes.length ? oldBuild.changes.slice(0, 1)[0].commit : "HEAD^1"
    const commits = gitlog({
      repo: config.repositoryPath,
      fields: ["hash", "subject", "rawBody"],
      branch: lastBuild + "...HEAD"
    });
    commits.forEach(function (commit) {
      changes.push({
        "commit": commit.hash,
        "summary": commit.subject,
        "message": commit.rawBody
      });
    });
    const build = await database.collection("builds").insertOne({
      "project": project.value!._id,
      "version": version.value!._id,
      "number": config.buildNumber,
      "time": new Date(),
      "changes": changes,
      "downloads": buildDownloads,
      "promoted": false,
      "channel": config.buildChannel
    });
    console.log("Inserted build " + config.buildNumber + " (channel: " + config.buildChannel + ") for project " + project.value!.name + " (" + project.value!._id + ") version " + version.value!.name + " (" + version.value!._id + "): " + build.insertedId);
  }finally {
    for (let closeable of finallyList) {
      try {
        await closeable.close()
      }catch (e) {
        console.error("error when close finally list", e)
      }
    }
  }
  return 0
}

run().catch((it)=>{
  console.error(it)
  process.exit(1)
}).then(it=>{
  process.exit(it)
})
