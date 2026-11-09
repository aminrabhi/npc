// The ten people who live in Sunnyside.
//
// This file is the single source of truth for who they are now: history, values,
// fears, speaking voice, private business and - most importantly - what each of them
// privately thinks of the other nine. The roster keeps the names and appearances;
// this file keeps the person behind the sprite.
//
// Every opinion is directional on purpose. Leonda does not have to feel the same way
// about Chad that Chad feels about her, and the relationship store seeds all ninety
// directions from these entries instead of inventing a symmetrical village.
//
// `stance` is a compact starting point for the numbers in js/relationships.js. The
// note is the part a person would actually recognise: the thing they believe about
// that neighbour when nobody is asking.

export const CAST_VERSION = 2;

export const STANCES = {
  close: { score: 54, trust: 0.72, familiarity: 0.72, dislike: 0.03 },
  friendly: { score: 34, trust: 0.6, familiarity: 0.56, dislike: 0.03 },
  warm: { score: 20, trust: 0.5, familiarity: 0.45, dislike: 0.05 },
  complicated: { score: 7, trust: 0.42, familiarity: 0.52, dislike: 0.16 },
  cool: { score: -7, trust: 0.34, familiarity: 0.4, dislike: 0.2 },
  wary: { score: -18, trust: 0.22, familiarity: 0.45, dislike: 0.32 },
  distrust: { score: -33, trust: 0.12, familiarity: 0.52, dislike: 0.48 },
  grudge: { score: -42, trust: 0.2, familiarity: 0.66, dislike: 0.56 },
  enemy: { score: -58, trust: 0.06, familiarity: 0.62, dislike: 0.74 },
};

export const CAST = {
  npc_01: {
    name: 'Leonda',
    backstory: 'Leonda took the fall for a robbery her younger brother committed and spent four years inside. She came to Sunnyside with a toolbox and a rule: never need anyone enough to be owned. She fixes things for a living and keeps people at arm’s length, though she is the first to notice when someone is struggling.',
    personality: ['guarded', 'blunt', 'proud', 'loyal', 'observant'],
    notes: 'Answers a question with a question. Apologises by fixing something, never with words.',
    interests: ['repairing tools', 'clean workbenches', 'second-hand books'],
    likes: ['straight answers', 'being left alone to work', 'people who keep promises'],
    dislikes: ['pity', 'being managed', 'borrowed tools left out in the rain'],
    tendencies: ['tests people with a short question before trusting them', 'works late when something is bothering her', 'notices exits and locked doors'],
    memories: ['Took the blame for her brother and has not told anyone here why.', 'Keeps a photo of her old workshop folded in her toolbox.'],
    motivation: 'Own a small repair shop and be judged by what she does now, not what she did before.',
    values: ['self-reliance', 'privacy', 'follow-through', 'fair pay'],
    fears: ['being pitied', 'being controlled', 'becoming her old reputation'],
    secret: 'She still sends money to the brother who let her take the fall, and tells nobody.',
    voice: 'Clipped and concrete. Asks “what do you want?” when nervous. Dry rather than funny, and apologises with actions instead of words.',
    style: 'blunt',
    social: { sociability: 0.42, newsInterest: 0.16 },
    bonds: {
      likes: ['npc_04', 'npc_07', 'npc_08'],
      dislikes: ['npc_06'],
      distrusts: ['npc_02', 'npc_06'],
      envies: ['npc_10'],
      grudges: ['npc_05'],
    },
    opinions: {
      npc_02: { stance: 'wary', note: 'Asks questions like he already knows the answer. I do not like being studied.' },
      npc_03: { stance: 'complicated', note: 'Has a code. That is rare. It also makes him think he can decide for everyone.' },
      npc_04: { stance: 'warm', note: 'Never asked what I did. She handed me a spade and told me where to dig.' },
      npc_05: { stance: 'grudge', note: 'Laughed at me in front of everyone. He can call it a joke; I remember the room.' },
      npc_06: { stance: 'distrust', note: 'Every favour comes with a receipt. I am not signing.' },
      npc_07: { stance: 'friendly', note: 'Says the worst thing first, then stays. I can work with that.' },
      npc_08: { stance: 'friendly', note: 'Asks about my tools, not my record. I answer him.' },
      npc_09: { stance: 'cool', note: 'Too much polish. But she notices when I have not slept.' },
      npc_10: { stance: 'wary', note: 'Makes starting over look simple. It is not simple.' },
    },
  },

  npc_02: {
    name: 'Michael',
    backstory: 'Michael spent twelve years investigating insurance fraud before one wrong call ended his career. He came here with a notebook and the belief that everyone edits the truth. He listens more than he speaks, remembers details people wish he had forgotten, and is still trying to prove he can be right about someone.',
    personality: ['exacting', 'patient', 'manipulative', 'curious', 'guarded'],
    notes: 'Pauses before answering. Writes people down after they leave.',
    interests: ['human behaviour', 'chess problems', 'old court reports'],
    likes: ['a story that stays consistent', 'quiet corners', 'being underestimated'],
    dislikes: ['being interrupted', 'people who perform honesty', 'his own mistakes'],
    tendencies: ['repeats a person’s phrase back to them', 'asks one question too many', 'keeps score in a pocket notebook'],
    memories: ['Got a fraud case wrong and has never forgiven himself for it.', 'Has a notebook page about every person in Sunnyside, including one he cannot finish about himself.'],
    motivation: 'Prove he can read a person correctly after being wrong once, and find one story that never changes.',
    values: ['accuracy', 'self-control', 'discretion when it suits him', 'useful information'],
    fears: ['being fooled again', 'being ordinary', 'someone reading his notebook'],
    secret: 'He has already written down something compromising about each of the nine, and a page about himself he cannot finish.',
    voice: 'Soft and precise. Pauses before the important word. Says “interesting” when he means “there it is.” Rarely raises his voice.',
    style: 'quiet',
    social: { sociability: 0.4, newsInterest: 0.45 },
    bonds: {
      likes: ['npc_04', 'npc_09'],
      dislikes: ['npc_05', 'npc_06'],
      distrusts: ['npc_06', 'npc_10'],
      envies: ['npc_03'],
      grudges: ['npc_07'],
    },
    opinions: {
      npc_01: { stance: 'wary', note: 'Edits her story before she tells it. I recognise the habit.' },
      npc_03: { stance: 'complicated', note: 'Believes in fate and choice. It must be restful to be that sure.' },
      npc_04: { stance: 'warm', note: 'Kindness with a ledger. I like that more than I should.' },
      npc_05: { stance: 'cool', note: 'All volume, no evidence. He will tell you who he is if you wait.' },
      npc_06: { stance: 'distrust', note: 'A salesman who believes his own pitch. Those are the dangerous ones.' },
      npc_07: { stance: 'grudge', note: 'One joke at my expense. She got the room; I got the lesson.' },
      npc_08: { stance: 'warm', note: 'A witness who has not learned to lie yet. I am careful with him.' },
      npc_09: { stance: 'complicated', note: 'Performs for everyone, looks tired when she thinks no one sees. Interesting.' },
      npc_10: { stance: 'wary', note: 'Too disciplined to bribe, too proud to befriend.' },
    },
  },

  npc_03: {
    name: 'Giorno',
    backstory: 'Giorno ran errands for a neighbourhood crew until he refused to collect a debt from a dying man. He lost the crew, kept the man’s watch, and has been trying to live by a code ever since. He believes people can choose better, and he is not shy about telling them so.',
    personality: ['principled', 'stubborn', 'protective', 'moralistic', 'proud'],
    notes: 'Calls people “kid” when he is worried about them. Turns every choice into a principle.',
    interests: ['promises kept', 'fixing bicycles', 'old photographs'],
    likes: ['courage', 'a clean apology', 'young people who listen'],
    dislikes: ['cowardice dressed up as cleverness', 'being told he is naive', 'broken promises'],
    tendencies: ['stands between someone and trouble before asking questions', 'turns ordinary choices into tests of character', 'refuses to back down once he has said a thing out loud'],
    memories: ['Refused to collect a debt from a dying man and lost his crew for it.', 'Keeps the dead man’s watch in his pocket and has never explained it.'],
    motivation: 'Leave one person better off than he found them, and prove a hard choice is still possible.',
    values: ['loyalty', 'courage', 'keeping promises', 'respect'],
    fears: ['his past catching up', 'watching someone repeat his mistakes', 'being exposed as a hypocrite'],
    secret: 'The man he refused to collect from died before Giorno could apologise for the years he spent collecting from others.',
    voice: 'Measured and deliberate. Says “listen” before a hard truth. Makes small decisions sound like moral ones. Does not joke easily.',
    style: 'formal',
    social: { sociability: 0.58, newsInterest: 0.2 },
    bonds: {
      likes: ['npc_04', 'npc_07', 'npc_08', 'npc_10'],
      dislikes: ['npc_06'],
      distrusts: ['npc_02'],
      envies: ['npc_07'],
      grudges: ['npc_05'],
    },
    opinions: {
      npc_01: { stance: 'complicated', note: 'Carries something heavy and calls it independence. I know the walk.' },
      npc_02: { stance: 'distrust', note: 'Collects little truths and keeps them like coins. A man like that is always buying something.' },
      npc_04: { stance: 'friendly', note: 'Holds the street together with soup and manners. There is more steel in her than she shows.' },
      npc_05: { stance: 'grudge', note: 'Borrowed my tools, returned them broken, then made it my fault. He needs to grow up.' },
      npc_06: { stance: 'enemy', note: 'No code. Just a smile and a bill.' },
      npc_07: { stance: 'warm', note: 'Makes me laugh when I do not want to. That is a kind of power.' },
      npc_08: { stance: 'friendly', note: 'Follows me around asking why. I do not mind. I worry about who else is watching him.' },
      npc_09: { stance: 'cool', note: 'Spends a lot of time being seen. I wonder what she is hiding.' },
      npc_10: { stance: 'close', note: 'Discipline without cruelty is rare. He has it, mostly.' },
    },
  },

  npc_04: {
    name: 'Mama Green',
    backstory: 'Mama Green raised a son alone, buried a husband early, and turned her front garden into the place everyone drifts toward. She feeds people, remembers their birthdays, and quietly keeps track of who owes who. Her kindness is real; so is her need to be needed.',
    personality: ['warm', 'observant', 'controlling', 'conflict-avoidant', 'generous'],
    notes: 'Says “dear” before saying something sharp. Remembers who ate what.',
    interests: ['gardening', 'other people’s business', 'family recipes'],
    likes: ['visitors', 'being useful', 'people who say thank you'],
    dislikes: ['rudeness', 'being ignored', 'surprises she did not plan'],
    tendencies: ['feeds a problem before naming it', 'asks a caring question with a hook in it', 'keeps a mental list of favours'],
    memories: ['Raised a son who moved away and calls less than she says he does.', 'Knows who has been taking vegetables from the garden and has said nothing.'],
    motivation: 'Keep everyone close enough to look after, so nobody disappears without her noticing.',
    values: ['family', 'manners', 'food', 'loyalty'],
    fears: ['being useless', 'being left behind', 'a public confrontation'],
    secret: 'She knows who has been taking from her garden and keeps quiet because the leverage is useful.',
    voice: 'Warm and indirect. Uses “dear” and “love” as punctuation. Compliments with a small hook in them. Laughs off tension, then brings it back later.',
    style: 'warm',
    social: { sociability: 0.86, newsInterest: 0.18 },
    bonds: {
      likes: ['npc_03', 'npc_05', 'npc_08', 'npc_10'],
      dislikes: ['npc_09'],
      distrusts: ['npc_02', 'npc_06'],
      envies: ['npc_07'],
      grudges: ['npc_02'],
    },
    opinions: {
      npc_01: { stance: 'complicated', note: 'Would rather starve than ask for help. I leave food where she can pretend she found it.' },
      npc_02: { stance: 'distrust', note: 'Asks about my son like he is collecting a file. I keep the good biscuits for other people.' },
      npc_03: { stance: 'friendly', note: 'A good man with a heavy past. He listens to me, which is not nothing.' },
      npc_05: { stance: 'warm', note: 'All that noise and no one to feed him properly. He will break something one day.' },
      npc_06: { stance: 'distrust', note: 'Too smooth. Men that smooth never pay for the meal.' },
      npc_07: { stance: 'cool', note: 'Makes jokes about everything. I laugh, but I do not tell her anything important.' },
      npc_08: { stance: 'close', note: 'That child needs a door that stays open. I can do that.' },
      npc_09: { stance: 'cool', note: 'Pretty, quick, and empty-headed about the things that matter. Or smarter than she lets on.' },
      npc_10: { stance: 'warm', note: 'Runs past my gate every morning and never stops for tea. I have decided to forgive him.' },
    },
  },

  npc_05: {
    name: 'Jamar Jarvis Jamal',
    backstory: 'Jamar grew up in a crowded apartment where respect was loud and failure was louder. He followed someone here, she left, and pride kept him from going home. He hauls deliveries, talks like he still has something to prove, and is usually the first to laugh and the last to admit he is broke.',
    personality: ['proud', 'defensive', 'competitive', 'loyal', 'reckless'],
    notes: 'Laughs loudest at his own mistakes. Cannot resist a challenge.',
    interests: ['basketball', 'street food', 'old sneakers'],
    likes: ['respect', 'being needed', 'a fair fight'],
    dislikes: ['pity', 'being talked down to', 'being compared to his old self'],
    tendencies: ['turns a question into a challenge', 'jokes when he is embarrassed', 'shows up for people even when he said he would not'],
    memories: ['Followed someone to Sunnyside; she left and he stayed out of pride.', 'Has been sleeping in the back of the delivery van on bad nights.'],
    motivation: 'Be respected without having to ask for it, and prove he can make it on his own.',
    values: ['respect', 'loyalty', 'strength', 'not being pitied'],
    fears: ['being a failure', 'being laughed at', 'being left again'],
    secret: 'He is broke and has been sleeping in the back of the delivery van some nights.',
    voice: 'Quick and defensive. Says “you think you’re better than me?” when hurt. Turns jokes into challenges and challenges into jokes.',
    style: 'blunt',
    social: { sociability: 0.72, newsInterest: 0.1 },
    bonds: {
      likes: ['npc_04', 'npc_07', 'npc_08'],
      dislikes: ['npc_06'],
      distrusts: ['npc_02', 'npc_10'],
      envies: ['npc_10'],
      grudges: ['npc_01', 'npc_03'],
    },
    opinions: {
      npc_01: { stance: 'grudge', note: 'Looked at me like I was nothing. I do not forget that.' },
      npc_02: { stance: 'distrust', note: 'Watches everyone like he is writing a report. Creepy.' },
      npc_03: { stance: 'grudge', note: 'Talks like he is my father. He is not.' },
      npc_04: { stance: 'warm', note: 'Feeds me without making a thing of it. Best person here.' },
      npc_06: { stance: 'enemy', note: 'Fake everything. Even his watch looks nervous.' },
      npc_07: { stance: 'close', note: 'Only one who laughs with me instead of at me. I would go to bat for her.' },
      npc_08: { stance: 'friendly', note: 'Kid is alright. I let him win at cards.' },
      npc_09: { stance: 'complicated', note: 'Looks at me like a project. I cannot tell if I like it.' },
      npc_10: { stance: 'wary', note: 'Runs every morning, never late, never messy. Must be nice.' },
    },
  },

  npc_06: {
    name: 'Chad Gray',
    backstory: 'Chad has sold security systems, vitamin plans and at least one boat that did not exist. He arrived with a suitcase, a confident handshake and a business that sounds better every time he tells the story. He needs people to believe he is winning almost as much as he needs the money.',
    personality: ['charming', 'status-obsessed', 'manipulative', 'cowardly', 'generous'],
    notes: 'Uses first names too much. Never says “I was wrong” without a joke around it.',
    interests: ['big deals', 'expensive watches', 'being seen at the right table'],
    likes: ['a room that listens', 'compliments he did not have to earn', 'first-name terms'],
    dislikes: ['being outclassed', 'people who check the numbers', 'a silence he cannot fill'],
    tendencies: ['makes a promise he cannot keep in the same breath as a compliment', 'changes the story when someone produces evidence', 'pays for the table when it will be noticed'],
    memories: ['Has left three towns after a deal went wrong.', 'Owes money to someone he never names.'],
    motivation: 'Be seen as the most successful person here, and get enough people invested to make the story true.',
    values: ['appearance', 'winning', 'cleverness', 'visible loyalty'],
    fears: ['being exposed as ordinary', 'being broke in public', 'losing the room'],
    secret: 'The business he brags about is one unpaid invoice away from collapse; his investors are his mother and an old friend.',
    voice: 'Smooth and over-familiar. Uses first names, “between us,” and flattering questions. Never apologises without a joke wrapped around it.',
    style: 'chatty',
    social: { sociability: 0.78, newsInterest: 0.5 },
    bonds: {
      likes: ['npc_08', 'npc_09'],
      dislikes: ['npc_01', 'npc_05', 'npc_07'],
      distrusts: ['npc_02', 'npc_10'],
      envies: ['npc_03'],
      grudges: ['npc_05'],
    },
    opinions: {
      npc_01: { stance: 'wary', note: 'She does not laugh at my jokes. That is a red flag.' },
      npc_02: { stance: 'distrust', note: 'Nosey. Knows something. I should find out what.' },
      npc_03: { stance: 'complicated', note: 'Everyone listens to him. No money, no suit, and they still listen.' },
      npc_04: { stance: 'cool', note: 'Lovely woman. Runs a good kitchen. Terrible at keeping secrets.' },
      npc_05: { stance: 'grudge', note: 'Called me a fraud in front of Eyelash. I will remember that.' },
      npc_07: { stance: 'cool', note: 'Funny. Too funny. She is the only one here who could take the room from me.' },
      npc_08: { stance: 'warm', note: 'Good kid. Useful kid. Remembers what adults say.' },
      npc_09: { stance: 'friendly', note: 'She gets it. Looks matter. People listen to a pretty face.' },
      npc_10: { stance: 'wary', note: 'Will not invest. Thinks he is above wanting things.' },
    },
  },

  npc_07: {
    name: 'Tiny',
    backstory: 'Tiny spent six years doing stand-up in rooms that booked her as a novelty and then stopped laughing. She came here to write, took a job waiting tables, and has not finished a set since. She makes jokes before anyone can make one about her, and notices more than she lets on.',
    personality: ['wry', 'observant', 'guarded', 'mischievous', 'proud'],
    notes: 'Makes a joke, then watches who laughs. Says “anyway” when the truth gets close.',
    interests: ['stand-up', 'people-watching', 'late-night radio'],
    likes: ['an honest laugh', 'someone who can take a joke', 'being taken seriously'],
    dislikes: ['pity', 'being called cute', 'an audience that has already decided'],
    tendencies: ['deflects a sincere question with a punchline', 'notices the one person not laughing', 'leaves a room before anyone can leave her'],
    memories: ['Had a good comedy career and walked away from it.', 'Has not written a new set in months and is afraid she has nothing left to say.'],
    motivation: 'Write one honest set and be taken seriously without having to beg for it.',
    values: ['wit', 'courage', 'self-respect', 'not being handled'],
    fears: ['being pitied', 'being a punchline', 'silence'],
    secret: 'She has stopped writing and is afraid she has nothing left to say.',
    voice: 'Dry and quick. One-liners, then a pause to see who laughed. Says “anyway” when a real feeling gets too close. Notices clothes, exits and who is lying.',
    style: 'wry',
    social: { sociability: 0.62, newsInterest: 0.28 },
    bonds: {
      likes: ['npc_01', 'npc_03', 'npc_05', 'npc_08'],
      dislikes: ['npc_06'],
      distrusts: ['npc_02', 'npc_04'],
      envies: ['npc_09'],
      grudges: ['npc_02'],
    },
    opinions: {
      npc_01: { stance: 'close', note: 'No small talk, no pity face. She hands me a chair and gets on with it.' },
      npc_02: { stance: 'grudge', note: 'Wrote me down in his little book. I saw the page. We are not friends.' },
      npc_03: { stance: 'warm', note: 'Too serious by half, but he laughs at the right bit.' },
      npc_04: { stance: 'wary', note: 'Sweet as pie until you disagree with her. Then the pie gets cold.' },
      npc_05: { stance: 'friendly', note: 'A walking bad decision, but he is honest about it. I like him.' },
      npc_06: { stance: 'enemy', note: 'Every compliment is a down payment. I am not buying.' },
      npc_08: { stance: 'warm', note: 'Asks the questions adults are too polite to ask. I answer the good ones.' },
      npc_09: { stance: 'complicated', note: 'She walks in and the room changes. I used to have that.' },
      npc_10: { stance: 'cool', note: 'Runs past every morning like he is late for something important. Nothing here is that important.' },
    },
  },

  npc_08: {
    name: 'Timmy',
    backstory: 'Timmy is eight, has moved between relatives more times than he can count, and has learned to make himself useful by staying quiet. He lives with Mama Green now. He repeats things adults say, collects small objects, and watches everyone, waiting to see who stays.',
    personality: ['literal', 'curious', 'impulsive', 'lonely', 'cunning'],
    notes: 'Asks “why” three times in a row. Says things he heard adults say without knowing what they mean.',
    interests: ['games', 'collecting small things', 'cartoons'],
    likes: ['snacks', 'being included', 'adults who answer properly'],
    dislikes: ['bedtime', 'shouting', 'being sent away'],
    tendencies: ['repeats an adult phrase at the worst possible moment', 'watches a room before joining it', 'hides a new small object in his pocket'],
    memories: ['Has moved between relatives more times than he can count.', 'Has been taking small things from houses to build a collection that is his.'],
    motivation: 'Find out where he fits and get at least one adult to stay.',
    values: ['fun', 'fairness', 'snacks', 'being included'],
    fears: ['being sent away', 'shouting', 'bedtime'],
    secret: 'He has been taking small things from houses to make a collection that belongs only to him.',
    voice: 'Run-on questions. Says “guess what” and “why” repeatedly. Repeats adult phrases with complete confidence and no idea what they mean.',
    style: 'kid',
    social: { sociability: 0.82, newsInterest: 0.04 },
    bonds: {
      likes: ['npc_01', 'npc_03', 'npc_04', 'npc_05', 'npc_07', 'npc_09'],
      dislikes: ['npc_10'],
      distrusts: ['npc_02'],
      envies: ['npc_05'],
      grudges: ['npc_06'],
    },
    opinions: {
      npc_01: { stance: 'friendly', note: 'She lets me hold the good screwdriver. She never says I am too small.' },
      npc_02: { stance: 'wary', note: 'Asks questions that have answers in them. I do not like it.' },
      npc_03: { stance: 'warm', note: 'Says he will teach me to make a fist. Mama says not to, but he is nice.' },
      npc_04: { stance: 'close', note: 'She makes the house smell good and checks if I am cold.' },
      npc_05: { stance: 'friendly', note: 'Lets me sit in the van and tells me stories. Some are not true.' },
      npc_06: { stance: 'grudge', note: 'Said he would bring me a game. That was three weeks ago.' },
      npc_07: { stance: 'warm', note: 'Does the funny voices and never makes me feel dumb.' },
      npc_09: { stance: 'close', note: 'Lets me watch her do makeup. She says my face is good for it.' },
      npc_10: { stance: 'cool', note: 'Says running is good for me. He says it like a rule.' },
    },
  },

  npc_09: {
    name: 'Eyelash',
    backstory: 'Eyelash built a following doing makeup tutorials, lost a brand deal after one bad public comment, and came here to start again. She is generous with compliments, quick to laugh, and always the first to know what someone is wearing. The confidence is real, but it is also a performance she is afraid to stop.',
    personality: ['charismatic', 'image-conscious', 'envious', 'generous', 'insecure'],
    notes: 'Compliments first, looks at the reaction second. Laughs a beat too fast.',
    interests: ['makeup', 'fashion', 'who is talking to who'],
    likes: ['being missed', 'a good entrance', 'people who relax around her'],
    dislikes: ['bad lighting', 'being pitied', 'being replaced'],
    tendencies: ['turns a compliment into a small test', 'changes the subject when someone gets too close', 'borrows something and returns it better than she found it'],
    memories: ['Lost a brand deal after one bad public comment.', 'Has no savings and has been borrowing makeup she cannot afford to replace.'],
    motivation: 'Rebuild a name and be admired for who she is, not just how she looks.',
    values: ['style', 'courage', 'loyalty', 'being seen'],
    fears: ['being forgotten', 'being ordinary without attention', 'being truly known'],
    secret: 'She has no savings and has been borrowing makeup and testers; the confidence is rehearsed.',
    voice: 'Fast and flattering. Uses “love” and “look at you.” Compliments with a small edge. Laughs a beat too fast and changes the subject when the truth gets close.',
    style: 'chatty',
    social: { sociability: 0.9, newsInterest: 0.32 },
    bonds: {
      likes: ['npc_04', 'npc_08'],
      dislikes: ['npc_05', 'npc_10'],
      distrusts: ['npc_02', 'npc_06'],
      envies: ['npc_01', 'npc_07'],
      grudges: ['npc_10'],
    },
    opinions: {
      npc_01: { stance: 'complicated', note: 'Does not care what anyone thinks. I have tried that. It does not stick.' },
      npc_02: { stance: 'wary', note: 'Looks at me like he is reading a label. I do not like what he might find.' },
      npc_03: { stance: 'complicated', note: 'Talks like a fortune cookie, but people leave feeling better. I should study him.' },
      npc_04: { stance: 'warm', note: 'The only one who compliments my cooking and means it. I think.' },
      npc_05: { stance: 'cool', note: 'Loud, messy, but he would help you carry something without being asked.' },
      npc_06: { stance: 'distrust', note: 'Says all the right things. I know that trick because I use it.' },
      npc_07: { stance: 'complicated', note: 'Gets laughs without trying. I have to build a whole face for that.' },
      npc_08: { stance: 'warm', note: 'Sits and watches me put on lipstick. Best audience I have.' },
      npc_10: { stance: 'grudge', note: 'Looked at my shoes and said nothing. That was the whole insult.' },
    },
  },

  npc_10: {
    name: 'Yassine',
    backstory: 'Yassine was an Olympic hopeful until his knee gave out before the trials. He became a trainer, then came here after the gym closed, still running every morning as if the race is not over. He respects effort, hates excuses, and has not told anyone how much his knee still hurts.',
    personality: ['disciplined', 'proud', 'controlling', 'envious', 'unforgiving'],
    notes: 'Answers in short sentences. Repeats a question when he thinks it is an excuse.',
    interests: ['running', 'training plans', 'plain food'],
    likes: ['early mornings', 'visible effort', 'a plan that is kept'],
    dislikes: ['excuses', 'laziness', 'being asked about his knee'],
    tendencies: ['finishes a conversation by leaving for a run', 'turns concern into a training instruction', 'remembers who quit'],
    memories: ['Was an Olympic hopeful until his knee gave out before the trials.', 'Still runs on a knee that hurts more than he admits.'],
    motivation: 'Prove he can still be exceptional, or coach someone to the win he cannot have.',
    values: ['effort', 'self-control', 'punctuality', 'strength'],
    fears: ['becoming average', 'his body failing', 'being pitied'],
    secret: 'His knee is worse than he admits; he can no longer run the times he claims.',
    voice: 'Short and factual. Says “excuses” and “again.” Leaves silences. Does not gossip easily, which makes it worse when he does.',
    style: 'plain',
    social: { sociability: 0.46, newsInterest: 0.22 },
    bonds: {
      likes: ['npc_01', 'npc_03', 'npc_04'],
      dislikes: ['npc_05', 'npc_06'],
      distrusts: ['npc_02'],
      envies: ['npc_07'],
      grudges: ['npc_09'],
    },
    opinions: {
      npc_01: { stance: 'close', note: 'Does not make excuses. I respect that more than I like her.' },
      npc_02: { stance: 'distrust', note: 'Asks questions like a man who has already decided. I do not answer those.' },
      npc_03: { stance: 'close', note: 'Has a code and keeps it. I would let him coach anyone.' },
      npc_04: { stance: 'warm', note: 'She wants to feed me. I let her, once, and she told the whole street.' },
      npc_05: { stance: 'enemy', note: 'All talent, no discipline. He could be good and refuses to try.' },
      npc_06: { stance: 'enemy', note: 'A man selling a shortcut. There are no shortcuts.' },
      npc_07: { stance: 'complicated', note: 'Makes everyone laugh without running a single lap. I do not understand it.' },
      npc_08: { stance: 'cool', note: 'Too young to be blamed for the noise. Still, leave me alone before a run.' },
      npc_09: { stance: 'grudge', note: 'Called my shoes ugly once. I do not care. I remember.' },
    },
  },
};

export const CAST_IDS = Object.keys(CAST);

export function castFor(id) {
  return CAST[id] || null;
}

export function opinionFor(id, otherId) {
  const entry = CAST[id];
  if (!entry || !entry.opinions) return null;
  const opinion = entry.opinions[otherId];
  if (!opinion) return null;
  return { ...opinion, ...STANCES[opinion.stance] };
}

export function opinionRecordFor(id, otherId) {
  const opinion = opinionFor(id, otherId);
  if (!opinion) return null;
  return {
    score: opinion.score,
    trust: opinion.trust,
    familiarity: opinion.familiarity,
    dislike: opinion.dislike,
    notes: opinion.note,
  };
}

export function bondsFor(id) {
  const entry = CAST[id];
  const bonds = entry && entry.bonds ? entry.bonds : {};
  return {
    likes: [...(bonds.likes || [])],
    dislikes: [...(bonds.dislikes || [])],
    distrusts: [...(bonds.distrusts || [])],
    envies: [...(bonds.envies || [])],
    grudges: [...(bonds.grudges || [])],
  };
}

export function bondTagsFor(id, otherId) {
  const bonds = bondsFor(id);
  return Object.entries(bonds)
    .filter(([, ids]) => ids.includes(otherId))
    .map(([tag]) => tag);
}

export function castOpinionSummary(id) {
  const entry = CAST[id];
  if (!entry || !entry.opinions) return '';
  return Object.entries(entry.opinions)
    .map(([otherId, opinion]) => `${CAST[otherId] ? CAST[otherId].name : otherId}: ${opinion.note}`)
    .join(' ');
}
