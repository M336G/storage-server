# storage-server
An easy to setup and optimized storing solution.

## How to setup?
1. Clone the repository with `git clone https://github.com/M336G/storage-server.git`.
2. Install [Bun](https://bun.sh/) and run `bun install`.
3. Run the project with `bun run start`.

## Recommandations
It is recommended that you set this up with a Cloudflare reverse proxy for the best performances. You should also set a [token](https://github.com/M336G/storage-server/blob/29e8ce5c2624aafd61314ae54f4d26332c9e91ea/.env.example#L4) and a [maximum rate limit](https://github.com/M336G/storage-server/blob/29e8ce5c2624aafd61314ae54f4d26332c9e91ea/.env.example#L7) in your environement variables (create a .env file).

## Configuring
See the [.env.example](https://github.com/M336G/storage-server/blob/main/.env.example) and the [config.json](https://github.com/M336G/storage-server/blob/main/config.json) files if you want to configure your storage server further.

**config.json**
| Setting | Description | Type | Default |
| --- | --- | --- | --- |
| `storagePath` | The path where you want your files to be stored | `String` | `data/storage` |
| `unaccessedDaysBeforeDeletion` | Period before your files get automatically deleted if they haven't been accessed (in days, disabled if null) | `Integer` | `null` |
| `maxStorageSize` | Maximum amount of gigabytes the server is able to store (unlimited if null) | `Integer` | `null` |
| `enableCompression` | Enable/Disable ZLib deflate compression | `Boolean` | `true` |

## Contributing
Feel free to open pull requests if you wish to contribute to the project!

## License
This project is licensed under the [GNU Affero General Public License v3.0](https://github.com/M336G/storage-server/blob/main/LICENSE)