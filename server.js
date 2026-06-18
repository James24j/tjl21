const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const allRestaurants = require('./data/restaurants');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// โครงสร้าง public ของคุณเป็นแบบนี้:
// public/
//   index.html
//   assets/
//   kin-rai-dee/
//     index.html
//     images/
app.use(express.static('public'));

const CATEGORIES = {
    rice: { label: 'ข้าว', emoji: '🍚' },
    noodle: { label: 'เส้น', emoji: '🍜' },
    'shabu-mukratha': { label: 'ชาบูหมูกระทะ', emoji: '🥘' },
    dessert: { label: 'ของหวาน', emoji: '🍰' }
};

const CATEGORY_KEYS = Object.keys(CATEGORIES);
const DEFAULT_ITEMS_PER_GAME = 12;
const MIN_ITEMS_PER_GAME = 1;

function getRandomItems(array, num) {
    const shuffled = [...array].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(num, shuffled.length));
}

function normalizeItemCount(itemCount) {
    if (itemCount === 'max') return 'max';

    const parsed = Number.parseInt(itemCount, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_ITEMS_PER_GAME;

    return Math.max(MIN_ITEMS_PER_GAME, parsed);
}

function getRoomItemCount(room, availableCount) {
    if (room.itemCountMode === 'max') return availableCount;

    const requestedCount = Math.max(DEFAULT_ITEMS_PER_GAME, ...room.itemCountRequests);
    return Math.min(requestedCount, availableCount);
}

function createEmptyCategoryVotes() {
    return CATEGORY_KEYS.reduce((votes, category) => {
        votes[category] = 0;
        return votes;
    }, {});
}

function getWinningCategory(categoryVotes) {
    return CATEGORY_KEYS
        .map(category => ({ category, votes: categoryVotes[category] || 0 }))
        .sort((a, b) => b.votes - a.votes)[0].category;
}

function prepareRestaurantForClient(restaurant) {
    return {
        name: restaurant.name || 'ร้านอาหาร',
        category: restaurant.category || 'rice',
        image: restaurant.image || '',
        mapUrl: restaurant.mapUrl || 'https://maps.google.com'
    };
}

function getResultPayload(roomCode) {
    const room = rooms[roomCode];
    const votes = room.votes;
    let winner = 'ไม่มีใครอยากกินอะไรเลย!';
    let maxVotes = 0;
    let mapUrl = '';

    if (Object.keys(votes).length > 0) {
        winner = Object.keys(votes).reduce((a, b) => votes[a] > votes[b] ? a : b);
        maxVotes = votes[winner];

        const winnerObj = room.items.find(item => item.name === winner);
        if (winnerObj) mapUrl = winnerObj.mapUrl;
    }

    return { winner, maxVotes, mapUrl };
}

const rooms = {};

io.on('connection', (socket) => {
    socket.on('joinRoom', (roomCode) => {
        if (!roomCode) return;

        socket.join(roomCode);
        socket.data.roomCode = roomCode;
        socket.data.categoryVoted = false;
        socket.data.finishedVoting = false;

        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                users: 0,
                categoryVotes: createEmptyCategoryVotes(),
                categoryFinishedUsers: 0,
                items: [],
                itemCountRequests: [],
                itemCountMode: 'number',
                votes: {},
                finishedUsers: 0
            };
        }

        rooms[roomCode].users++;
        socket.emit('startCategoryVote');
        io.to(roomCode).emit('updateUserCount', rooms[roomCode].users);
    });

    socket.on('voteCategory', ({ roomCode, category, itemCount }) => {
        if (!rooms[roomCode]) return;
        if (!CATEGORY_KEYS.includes(category)) return;
        if (socket.data.categoryVoted) return;

        socket.data.categoryVoted = true;
        const normalizedItemCount = normalizeItemCount(itemCount);
        if (normalizedItemCount === 'max') {
            rooms[roomCode].itemCountMode = 'max';
        } else {
            rooms[roomCode].itemCountRequests.push(normalizedItemCount);
        }

        rooms[roomCode].categoryVotes[category]++;
        rooms[roomCode].categoryFinishedUsers++;

        if (rooms[roomCode].categoryFinishedUsers >= rooms[roomCode].users) {
            const winningCategory = getWinningCategory(rooms[roomCode].categoryVotes);
            const filteredItems = allRestaurants.filter(item => item.category === winningCategory);
            const finalItemCount = getRoomItemCount(rooms[roomCode], filteredItems.length);
            const selectedItems = getRandomItems(filteredItems, finalItemCount).map(prepareRestaurantForClient);

            rooms[roomCode].items = selectedItems;
            io.to(roomCode).emit('startGame', {
                category: winningCategory,
                categoryLabel: CATEGORIES[winningCategory].label,
                categoryEmoji: CATEGORIES[winningCategory].emoji,
                itemCount: selectedItems.length,
                maxAvailableItems: filteredItems.length,
                items: selectedItems
            });
        }
    });

    socket.on('swipeRight', ({ roomCode, item }) => {
        if (!rooms[roomCode] || !item || !item.name) return;

        const itemName = item.name;
        if (!rooms[roomCode].votes[itemName]) rooms[roomCode].votes[itemName] = 0;
        rooms[roomCode].votes[itemName]++;
    });

    socket.on('finishVoting', (roomCode) => {
        if (!rooms[roomCode]) return;
        if (socket.data.finishedVoting) return;

        socket.data.finishedVoting = true;
        rooms[roomCode].finishedUsers++;

        if (rooms[roomCode].finishedUsers >= rooms[roomCode].users) {
            io.to(roomCode).emit('result', getResultPayload(roomCode));
        }
    });

    socket.on('forceEndGame', (roomCode) => {
        if (!rooms[roomCode]) return;
        io.to(roomCode).emit('result', getResultPayload(roomCode));
    });

    socket.on('disconnect', () => {
        const roomCode = socket.data.roomCode;
        if (!roomCode || !rooms[roomCode]) return;

        rooms[roomCode].users = Math.max(0, rooms[roomCode].users - 1);

        if (rooms[roomCode].users === 0) {
            delete rooms[roomCode];
        } else {
            io.to(roomCode).emit('updateUserCount', rooms[roomCode].users);
        }
    });
});

const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => {
    console.log(`Server is running on port ${port}`);
});
