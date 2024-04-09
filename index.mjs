"use strict";

import config from "./config.mjs";
import {
    MatrixClient,
    AutojoinRoomsMixin,
    RichRepliesPreprocessor,
} from "matrix-bot-sdk";
import FormData from "form-data";
import axios from "axios";
import sizeOf from "image-size";
import escapeHtml from "escape-html";

let user_id;
const client = new MatrixClient(config.homeserver, config.token);

function get_command_argument(event) {
    return event["content"]["body"]
        .slice(config.prefix.length)
        .split(" ")
        .slice(1)
        .join(" ")
        .trim();
}

async function cmd_quote(room_id, event) {
    let caption = get_command_argument(event).substring(0, 128);

    if (!caption) {
        await client.replyText(
            room_id,
            event,
            `Usage: !quote <caption> - takes the replied to image and uploads it to ${config.imag}`,
        );
        return;
    }

    let original_message = await client.getEvent(
        room_id,
        event["content"]["m.relates_to"]["m.in_reply_to"]["event_id"],
    );

    let image_url = original_message.content.url;

    if (!image_url || !image_url.startsWith("mxc://")) return;

    let image = await axios.get(client.mxcToHttp(image_url), {
        responseType: "arraybuffer",
    });

    let data = new FormData();

    data.append("desc", caption);
    data.append("key", config.imag_key);
    data.append("image", image.data, { filename: "quote.jpg" });

    axios({
        method: "post",
        url: config.imag,
        headers: {
            ...data.getHeaders(),
        },
        data: data,
    })
        .then((r) => {
            if (r.status >= 400)
                throw new Error(
                    `Failed to POST the image. Response code: ${r.status}`,
                );

            axios.get(`${config.imag}/api/count`).then(async (r) => {
                await client.replyText(
                    room_id,
                    event,
                    `Quote #${r.data} posted! Check it out at ${config.imag}#${r.data} or ${config.imag}image/${r.data} :)`,
                );
            });
        })
        .catch(async (e) => {
            await client.replyText(room_id, event, "Error!");
            console.error(e);
        });
}

async function cmd_get(room_id, event) {
    let q = get_command_argument(event);
    let image_url, image_id;

    if (!q) {
        await client.replyText(
            room_id,
            event,
            "Usage: !get <quote ID> OR (newest:)(n (result number, starting from 1):)<query> - gets a quote by its ID, or searches for it applying score or newest posted filters, also allows you to set which result to get",
        );
        return;
    }

    if (q.match(/^\d+$/)) {
        image_id = q;
        image_url = `${config.imag}image/${image_id}`;
    } else {
        let newest = q.startsWith("newest:");

        if (newest) q = q.slice(7);

        let n = 1;
        let matches = q.match(/^(\d+):/);

        if (matches !== null) {
            n = parseInt(matches[1]);
            q = q.replace(/^(\d+:)/, "").trim();
        }

        let results = await axios.get(
            `${config.imag}api/search?q=${encodeURIComponent(q)}&s=${newest ? "newest" : "score"}`,
        );

        if (results.status >= 400 || results.data.length < n) {
            client.replyText(room_id, event, "No such quotes found.");
            return;
        }

        image_id = Math.max(n - 1, 0);
        image_url = `${config.imag}image/${results.data[image_id].iid}`;
    }

    let image, metadata;

    try {
        image = await axios.get(image_url, {
            responseType: "arraybuffer",
        });
    } catch (e) {
        console.error(e);
        await client.replyText(room_id, event, "Failed to fetch the quote.");
        return;
    }

    try {
        metadata = (await axios.get(`${config.imag}api/image/${image_id}`))
            .data;
    } catch (e) {
        console.error(e);
        await client.replyText(
            room_id,
            event,
            "Failed to fetch the quote metadata.",
        );
        return;
    }

    let buffer = Buffer.from(image.data);

    let dimensions = sizeOf(buffer);
    let mime = image.headers["content-type"];
    let ext = mime === "image/png" ? "png" : "jpg";

    let content = {
        body: `quote-${image_id}.${ext}`,
        info: {
            size: image.data.byteLength,
            w: dimensions.width,
            h: dimensions.height,
            mimetype: mime,
        },
        msgtype: "m.image",
        url: undefined,
        "m.relates_to": {
            "m.in_reply_to": {
                event_id: event["event_id"],
            },
        },
    };

    content.url = await client.uploadContent(buffer, {
        filename: `quote.${ext}`,
        type: mime,
    });

    let image_msg = await client.getEvent(
        room_id,
        await client.sendMessage(room_id, content),
    );

    await client.replyHtmlText(
        room_id,
        image_msg,
        `Quote ${metadata.iid}: "${escapeHtml(metadata.desc)}" | ${metadata.score} ${metadata.score < 0 ? "\uD83D\uDC4E" : "\uD83D\uDC4D"}
<br/>
<br/>
Created: ${new Date(metadata.created * 1000).toUTCString()} | Edited: ${new Date(metadata.edited * 1000).toUTCString()}`,
    );
}

async function cmd_join(room_id, event) {
    let room = get_command_argument(event);

    if (!room) {
        await client.replyText(
            room_id,
            event,
            "Usage: !join <room ID or alias> - join a room",
        );
        return;
    }

    await client.joinRoom(room).catch(async () => {
        await client.replyText(
            room_id,
            event,
            "Failed to join the room. Invalid room ID?",
        );
    });
}

async function on_room_message(room_id, event) {
    if (
        !event["content"] ||
        !event["content"]["body"] ||
        event["sender"] === user_id
    )
        return;

    if (
        event["content"]["m.relates_to"] &&
        event["content"]["m.relates_to"]["m.in_reply_to"] &&
        event["content"]["body"]
            .toLowerCase()
            .startsWith(`${config.prefix}quote`)
    )
        await cmd_quote(room_id, event);
    else if (
        event["content"]["body"].toLowerCase().startsWith(`${config.prefix}get`)
    )
        await cmd_get(room_id, event);
    else if (
        event["content"]["body"]
            .toLowerCase()
            .startsWith(`${config.prefix}source`)
    )
        await client.replyText(
            room_id,
            event,
            "https://ari.lt/gh/quotes-bot (contact @ari:ari.lt for any details :))",
        );
    else if (
        event["content"]["body"]
            .toLowerCase()
            .startsWith(`${config.prefix}join`) &&
        event["sender"] === config.admin
    )
        await cmd_join(room_id, event);
    else if (
        event["content"]["body"]
            .toLowerCase()
            .startsWith(`${config.prefix}die`) &&
        event["sender"] === config.admin
    ) {
        await client.replyText(room_id, event, "Goodnight!");
        process.exit();
    }
}

function main() {
    if (config.autojoin) AutojoinRoomsMixin.setupOnClient(client);

    client.joinRoom(config.room);

    client.addPreprocessor(new RichRepliesPreprocessor(false));

    client.on("room.message", async (room_id, event) => {
        try {
            await on_room_message(room_id, event);
        } catch (e) {
            console.error(e);
            client.replyText(room_id, event, "Error!");
        }
    });

    client.start().then(async () => {
        user_id = await client.getUserId();
        console.log(`Bot started! User ID: ${user_id}`);
    });
}

main();
