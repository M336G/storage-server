# storage-server
An easy to setup and optimized storing solution using Bun.

## How to setup?
1. Clone the repository with `git clone https://github.com/M336G/storage-server.git`.
2. Install [Bun](https://bun.sh/) and run `bun install`.
3. Run the project with `bun run start`.

## Recommandations
It is recommended that you set this up with a Cloudflare reverse proxy for the best performances. You should also set a [token](https://github.com/M336G/storage-server/blob/12651f2bed26e6e78dd5d242154c0b5599982056/.env.example#L4) and a [maximum rate limit](https://github.com/M336G/storage-server/blob/12651f2bed26e6e78dd5d242154c0b5599982056/.env.example#L13) in your environement variables (create a .env file).

## Configuring
See the notes in [.env.example](https://github.com/M336G/storage-server/blob/main/.env.example) if you want to configure your storage server further.

## Contributing
Feel free to open pull requests if you wish to contribute to the project!

## License
This project is licensed under the [GNU Affero General Public License v3.0](https://github.com/M336G/storage-server/blob/main/LICENSE)
