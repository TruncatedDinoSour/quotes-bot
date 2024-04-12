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

function dlog(...data) {
    if (config.debug) console.info("[DEBUG]", ...data);
}

async function cmd_quote(room_id, event) {
    let caption = get_command_argument(event).substring(0, 128);

    dlog(`Quote ${caption} command invoked in ${room_id} by`, event);

    if (!caption) {
        await client.replyText(
            room_id,
            event,
            `Usage: quote <caption> - takes the replied to image and uploads it to ${config.imag}`,
        );
        return;
    }

    let original_message = await client.getEvent(
        room_id,
        event["content"]["m.relates_to"]["m.in_reply_to"]["event_id"],
    );

    let image_url = original_message.content.url;

    dlog(`Image URL: ${image_url}`);

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
            dlog(r);

            if (r.status >= 400)
                throw new Error(
                    `Failed to POST the image. Response code: ${r.status}`,
                );

            axios.get(`${config.imag}/api/latest`).then(async (r) => {
                await client.replyText(
                    room_id,
                    event,
                    `Quote #${r.data} posted! Check it out at ${config.imag}#${r.data} or ${config.imag}image/${r.data} :)`,
                );
            });
        })
        .catch(async (e) => {
            console.error(e);
            await client.replyText(room_id, event, "Error!");
        });
}

async function cmd_get(room_id, event) {
    let q = get_command_argument(event);
    let image_url, image_id;

    dlog(`Get ${q} command invoked in ${room_id} by`, event);

    if (!q) {
        await client.replyText(
            room_id,
            event,
            "Usage: get <quote ID> OR (newest:)(n (result number, starting from 1):)<query> - gets a quote by its ID, or searches for it applying score or newest posted filters, also allows you to set which result to get",
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

        image_id = results.data[Math.max(n - 1, 0)].iid;
        image_url = `${config.imag}image/${image_id}`;
    }

    dlog("Image ID:", image_id);
    dlog("Image URL:", image_url);

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
            "Failed to fetch the quote metadata, so won't sent the associated metadata with it.",
        );
    }

    dlog("Metadata:", metadata);

    let buffer = Buffer.from(image.data);

    let dimensions = sizeOf(buffer);
    let mime = image.headers["content-type"];
    let ext = mime === "image/png" ? "png" : "jpg";

    dlog("Dimensions:", dimensions);
    dlog("MIME:", mime);
    dlog("Extension:", ext);

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

    let mxc = await client.uploadContent(buffer, {
        filename: `quote.${ext}`,
        type: mime,
    });

    dlog("Image uploaded:", mxc);

    content.url = mxc;

    await client.sendMessage(room_id, content);

    if (metadata)
        await client.sendHtmlText(
            room_id,
        `<a href="${config.imag}#${image_id}">Quote ${metadata.iid}</a>: "${escapeHtml(metadata.desc)}"
<hr/>
<ul>
<li>Score: ${metadata.score} ${metadata.score < 0 ? "\uD83D\uDC4E" : "\uD83D\uDC4D"}</li>
<li>Created: ${new Date(metadata.created * 1000).toUTCString()}</li>
<li>Edited: ${new Date(metadata.edited * 1000).toUTCString()}</li>
</ul>
<blockquote>
${escapeHtml(metadata.ocr)}
<blockquote>`,
        );
}

async function cmd_join(room_id, event, action = "join", what = "Joined") {
    let room = get_command_argument(event);

    dlog(`Invoked ${action} ${room} command in ${room_id} by`, event);

    if (!room) {
        await client.replyText(
            room_id,
            event,
            `Usage: ${action} <room ID or alias> - ${action} a room`,
        );
        return;
    }

    try {
        dlog(`Resolving ${room}`);
        room = await client.resolveRoom(room);
    } catch (e) {
        console.error(e);
        await client.replyText(
            room_id,
            event,
            "Failed to resolve the room. Wrong room ID or alias?",
        );
        return;
    }

    await client[`${action}Room`](room)
        .then(async () => {
            await client.replyText(room_id, event, `${what} ${room}`);
        })
        .catch(async (e) => {
            console.error(e);
            await client.replyText(
                room_id,
                event,
                `Failed to ${action} the room. Invalid room ID?`,
            );
        });
}

async function cmd_leave(room_id, event) {
    await cmd_join(room_id, event, "leave", "Left");
}

async function cmd_score(room_id, event) {
    let n = 10,
        ns = get_command_argument(event);

    if (ns && ns.match(/^-?\d+$/)) n = parseInt(ns);

    if (n === 0) {
        client.replyText(room_id, event, "Usage: score <positive or negative number>");
        return;
    }

    let all;

    try {
        all = (await axios.get(`${config.imag}api/all`)).data;
    } catch (e) {
        console.error(e);
        await client.replyText(room_id, event, "Failed to fetch all quotes.");
    }

    let qs;

    if (n > 0) qs = all.slice(0, n);
    else if (n < 0) qs = all.slice(n);

    if (qs.length == 1) {
        event["content"]["body"] = `${config.prefix}get ${qs[0].iid}`;
        return await cmd_get(room_id, event);
    }

    let html = "<ul>";

    for (let idx = 0; idx < qs.length; ++idx) {
        let q = qs[idx];
        html += `<li><a href="${config.imag}#${q.iid}">Quote #${q.iid}</a> - "${escapeHtml(q.desc)}": ${q.score} ${q.score < 0 ? "\uD83D\uDC4E" : "\uD83D\uDC4D"}</li>`;
    }

    html += "</ul>";

    await client.replyHtmlText(room_id, event, html);
}

async function on_room_message(room_id, event) {
    // debug stuff

    if (config.debug && room_id !== config.room) return;

    // non-debug stuff

    if (
        !event["content"] ||
        !event["content"]["body"] ||
        event["sender"] === user_id
    )
        return;

    dlog(room_id, event);

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
            .startsWith(`${config.prefix}leave`) &&
        event["sender"] === config.admin
    )
        await cmd_leave(room_id, event);
    else if (
        event["content"]["body"]
            .toLowerCase()
            .startsWith(`${config.prefix}die`) &&
        event["sender"] === config.admin
    ) {
        dlog(`Die invoked in ${room_id} by`, event);
        await client.replyText(room_id, event, "Goodnight!");
        process.exit();
    } else if (
        event["content"]["body"]
            .toLowerCase()
            .startsWith(`${config.prefix}help`)
    )
        await client.replyHtmlText(
            room_id,
            event,
            `
Available commands:<br/>
<br/>
- quote <caption> - post a quote to ${config.imag}<br/>
- get <ID or (newest:)(Nth:)query> - get a quote<br/>
- source - get the source code of the bot<br/>
- join <room id> - join a room (admin only)<br/>
- leave <room id> - leave a room (admin only)<br/>
- die - make the bot shut down (admin only)<br/>
- help - print help<br/>
- score <negative or positive number = 10> - get the quotes with lowest or highest scores
`.trim(),
        );
    else if (
        event["content"]["body"]
            .toLowerCase()
            .startsWith(`${config.prefix}score`)
    )
        await cmd_score(room_id, event);
}

async function main() {
    if (!config.room && config.debug)
        throw new Error(
            "Please set config.room to use debug mode. The quotes bot will only respond to messages in that room.",
        );

    client.addPreprocessor(new RichRepliesPreprocessor(false));

    if (config.debug) {
        config.prefix = `${Math.random()}:${config.prefix}`;
        dlog(`Debug prefix: ${config.prefix}`);
    }

    if (config.autojoin) {
        dlog("Enabling autojoin");
        AutojoinRoomsMixin.setupOnClient(client);
    }

    await client.start().then(async () => {
        user_id = await client.getUserId();
        console.log(`Bot started! User ID: ${user_id}`);
    });

    if (config.room) {
        let r = await client.resolveRoom(config.room);
        dlog(`Joining ${config.room} (${r})`);
        config.room = r;
        await client.joinRoom(config.room);
    } else config.warn("No default room set");

    client.on("room.message", async (room_id, event) => {
        try {
            await on_room_message(room_id, event);
        } catch (e) {
            console.error(e);
            client.replyText(room_id, event, "Error!");
        }
    });
}

dlog("Hello, Debug!");
main();
