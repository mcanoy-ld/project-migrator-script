# Migrating More Than One Project At A Time

## Before you begin

Please read the top level [readme](./README.md) in this project.

## Notes

The all project scripts should be merged with the single project scripts. For the most part they are coded and work the same

## Limitations

* As with the single project script, the migration can take time. This may be too much for large scale migrations.
* In the single project script you can rename your project key. In the multiproject script you can ony append to the original key. However, this script will migrate the project name and if an append is requested it will append to both the project name and key.

## Usage

1. Exporting data for migration

First, export your source data. The `sourceAllProjects.ts` script writes the data to a newly created
`source/project/<source-project-key>` directory.

Here's how to export your source data:

```
deno --allow-net --allow-write --allow-read sourceAllProjects.ts -a  -k $MIG_SOURCE_LD_API_KEY
```

| Paramenter | Required | Description |
|---|---|---|
| a | no | Exports all projects to your local storage at `source/project/<source-project-key`. |
| k | yes | Your api key for the LD instance you are exporting |
| p | no | The project key. A value of only selecting one project to export | 
| u | no | The url of the LD instance. Defaults to `app.launchdarkly.com` |
| v | no | Verbose mode. Prints out a bit more info | 


2. Migrating data

Then, migrate the source data to the destination project. The `migrateAllProjects.ts` script reads the source data out of the previously created `source/project/<source-project-key>` directory. Then it uses the
`DESTINATION PROJECT` as the project key, and updates the destination project using a series of `POST`s and `PATCH`s.

Here's how to migrate the source data to your destination project:

```
deno run --allow-read --allow-net --allow-write migrateAllProjects.ts -p <SOURCE PROJECT KEY> -k <DESTINATION LD API KEY> -u <alternate.url.com> -n <append-value>

```

| Paramenter | Required | Description |
|---|---|---|
| a | no | Import all projects from your local storage at `source/project/<source-project-key`. |
| k | yes | Your api key for the LD instance you are importing to |
| n | no | A value to append to project key and name. Example: `-n eu` ==> Original Project Key: `my-project` New project key: `my-project-eu`. Required if writing to the same instance and keeping the old version (Can't have identical keys) |
| p | no | Not yet implemented. An array of project keys for projects to import | 
| u | no | The url of the LD instance. Defaults to `app.launchdarkly.com` |
| v | no | Verbose mode. Prints out a bit more info | 