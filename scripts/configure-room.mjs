import { pbkdf2Sync } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

const roomNumber = process.argv[2];
if (!["2", "3"].includes(roomNumber)) {
  console.error("사용법: node scripts/configure-room.mjs <2 또는 3>");
  process.exitCode = 1;
} else {
  const indexPath = new URL("../index.html", import.meta.url);
  const rulesPath = new URL("../firestore.rules", import.meta.url);
  const presenceRulesPath = new URL("../database.rules.json", import.meta.url);
  const html = await readFile(indexPath, "utf8");
  const rules = await readFile(rulesPath, "utf8");
  const presenceRules = JSON.parse(await readFile(presenceRulesPath, "utf8"));
  const configPattern = /const ADDITIONAL_ROOMS = (\[[\s\S]*?\]);/;
  const rooms = JSON.parse(html.match(configPattern)[1]);
  const projectId = html.match(/projectId: "([^"]+)"/)[1];
  const legacyRoomId = html.match(/const ROOM_ID = "([^"]+)"/)[1];
  const selected = rooms.find(room => room.id === `${legacyRoomId}-${roomNumber}`);
  if (rooms.length !== 2 || !selected) throw new Error("추가 방 설정을 확인하세요.");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const password = await rl.question(`${roomNumber}번 방 암호 (기존 방과 다른 값): `);
    const confirmation = await rl.question("암호 다시 입력: ");
    if (!password || password !== confirmation) throw new Error("암호가 비어 있거나 일치하지 않습니다.");
    const passwordHash = pbkdf2Sync(password, `chat-room-routing:${projectId}`, 100000, 32, "sha256").toString("hex");
    if (rooms.some(room => room !== selected && room.passwordHash === passwordHash)) {
      throw new Error("다른 추가 방과 같은 암호는 사용할 수 없습니다.");
    }
    selected.passwordHash = passwordHash;
    const allowedRooms = [legacyRoomId, ...rooms.filter(room => room.passwordHash).map(room => room.id)];
    const rulesPattern = /return room in \[[^\]]*\];/;
    if (!rulesPattern.test(rules)) throw new Error("Firestore 규칙의 방 목록을 찾지 못했습니다.");
    const presenceAllowed = `(${allowedRooms.map(id => `$room === '${id}'`).join(" || ")})`;
    const roomRules = presenceRules.rules.presence.$room;
    roomRules[".read"] = `auth != null && ${presenceAllowed}`;
    roomRules.$uid.$connection[".write"] = `auth != null && auth.uid === $uid && ${presenceAllowed}`;
    await writeFile(indexPath, html.replace(configPattern, `const ADDITIONAL_ROOMS = ${JSON.stringify(rooms, null, 2).replace(/\n/g, "\n    ")};`));
    await writeFile(rulesPath, rules.replace(rulesPattern, `return room in [${allowedRooms.map(id => `'${id}'`).join(", ")}];`));
    await writeFile(presenceRulesPath, JSON.stringify(presenceRules, null, 2) + "\n");
    console.log(`${roomNumber}번 방 설정 완료. 비밀번호 원문은 파일에 저장하지 않았습니다.`);
    console.log("사이트를 배포하고 Firebase 콘솔에 firestore.rules와 database.rules.json을 각각 게시하세요.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}
