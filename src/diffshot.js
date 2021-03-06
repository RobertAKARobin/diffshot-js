const git = require('simple-git/promise')()
const Jimp = require('jimp')
const fs = require('fs-extra')

function anchorify(input){
	return input
		.toLowerCase()
		.replace(/ /g, '-')
		.replace(/[^a-zA-Z0-9\-_]/g, '')
}

function colorText(jimp, hexInput){
	const colors = ['red', 'green', 'blue']
	const hexSegments = hexInput.match(/.{2}/g).map(hex=>parseInt(hex, 16))
	return jimp.color(colors.map((color, index)=>{
		return {apply: color, params: [hexSegments[index] || 0]}
	}))
}

function flatten(nestedArray){
	return nestedArray.reduce((output, item)=>{
		if(Array.isArray(item)){
			return output.concat(flatten(item))
		}else{
			return output.concat(item)
		}
	}, [])
}

function pathify(input){
	return input
		.toLowerCase()
		.replace(/ /g, '-')
		.replace(/[^a-zA-Z0-9-_\.]/g, '')
		.replace(/-{2,}/g, '-')
		.replace(/\.{2,}/g, '.')
		.replace(/^-/, '')
}

const defaultConfig = {
	filesToExclude: [
		'^.*-lock.json$',
		'^.*.fnt$'
	],
	outputImagePath: '_DIFFSHOT',
	outputDocPath: '_DIFFSHOT/README.md',
	fontFile: `${__dirname}/fonts/inconsolata_16.fnt`,
	fontLineIndentPx: 5,
	fontLineHeightPx: 20,
	fontColorMain: 'ffffff',
	fontColorDelete: 'ff0000',
	fontColorAdd: '00ff00',
	fontColorHeadline: 'ffff00',
	fontColorMeta: '00ffff',
	imageWidthPx: 800,
	imageBgColor: '000000',
}
module.exports = async function(config){
	for(let configProperty in defaultConfig){
		if(config[configProperty] === undefined){
			config[configProperty] = defaultConfig[configProperty]
		}
	}
	if(typeof config.exclude === 'string'){
		config.exclude = [config.exclude]
	}
	config.filesToExclude = config.filesToExclude.map(fileName=>new RegExp(fileName))

	const font = await Jimp.loadFont(config.fontFile)
	const glyphs = {
		main:		colorText(font.pages[0].clone(), config.fontColorMain),
		delete:		colorText(font.pages[0].clone(), config.fontColorDelete),
		add:		colorText(font.pages[0].clone(), config.fontColorAdd),
		headline:	colorText(font.pages[0].clone(), config.fontColorHeadline),
		meta:		colorText(font.pages[0].clone(), config.fontColorMeta),
	}

	if(config.doEraseOutputDirectory){
		await fs.emptyDir(`./${config.outputDirectory}`)
	}else{
		await fs.ensureDir(`./${config.outputDirectory}`)
	}

	const commitLog = (await git.log(config._)).all
	let commits = []
	for(let commitIndex = 0, rawCommit = null; rawCommit = commitLog[commitIndex]; commitIndex += 1){
		const previousRawCommit = commitLog[commitIndex + 1]
		// This is the hash of SHA1("tree 0\0"). It's a constant across all Git repos.
		const previousHash = (previousRawCommit ?  previousRawCommit.hash.substring(0, 8) : '4b825dc642cb6eb9a060e54bf8d69288fbee4904')
		// The '--' is necessary to specify files.
		const diffSummary = await git.diffSummary([`${previousHash}..${rawCommit.hash}`, '--'].concat(config._))
		const fileNames = diffSummary.files
			.map(file=>file.file)
			.filter(fileName=>{
				// Include only files that do *not* pass the 'filesToExclude' regexes
				return !config.filesToExclude.find(regex=>{
					return regex.test(fileName)
				})
			})
			.sort()
		const headline = rawCommit.message.split('\n')[0]
		const commit = {
			headline,
			body: rawCommit.body.replace(/\n/g, '<br>\n'),
			anchor: anchorify(headline),
			hash: rawCommit.hash.substring(0, 8),
			prevHash: previousHash,
			files: fileNames.map(fileName=>{
				const pathMessage = headline
					.toLowerCase()
					.substring(0,50)
					.replace(/ /g, '-')
					.replace(/[^a-zA-Z0-9-_]/g, '')
				const pathFilename = fileName
					.replace(/ /g, '-')
					.replace(/[^a-zA-Z0-9-_\.]/g, '')
				const imagePath = `${pathMessage}.${pathFilename}.png`
					.replace(/-{2,}/g, '-')
					.replace(/\.{2,}/g, '.')
					.replace(/^-/, '')
				return {
					name: fileName,
					imagePath,
					anchor: `${anchorify(rawCommit.message)}-${anchorify(fileName)}`
				}
			})
		}
		commits.push(commit)

		for(let fileIndex = 0, file = null; file = commit.files[fileIndex]; fileIndex += 1){
			const diff = await git.diff([`${commit.prevHash}..${commit.hash}`, '--', file.name])
			const diffByLine = diff.split('\n')
			const image = await (new Jimp(config.imageWidthPx, (config.fontLineHeightPx * diffByLine.length), config.imageBgColor))
	
			diffByLine.unshift(
				`# ${commit.hash}: ${commit.headline}`
			)
			diffByLine.forEach((line, lineIndex)=>{
				let glyphColor
				switch(line.substring(0,1)){
					case '-': glyphColor = glyphs.delete; break;
					case '+': glyphColor = glyphs.add; break;
					case '@': glyphColor = glyphs.meta; break;
					case '#': glyphColor = glyphs.headline; break;
					default:  glyphColor = glyphs.main
				}
				// font.pages is the font's reference to the .png file from which it gets its glyphs
				font.pages = [glyphColor]
				// (font file, x coordinate to start painting, y coordinate to start painting, text content)
				image.print(font, config.fontLineIndentPx, (config.fontLineHeightPx * lineIndex), line.replace(/\t/g, '   '))
			})
			await image.writeAsync(`./${config.outputDirectory}/${file.imagePath}`)
		}
	}

	if(config.isOldestCommitFirst){
		commits = commits.reverse()
	}

	const markdown = [
		'# Commit history' + ((config._ && config._.length > 0) ? ` (${config._})` : ''),
		'This visual commit history generated with [Diffshot](https://github.com/RobertAKARobin/diffshot).',
		'## Contents',
		commits.map(commit=>[
			`- [${commit.hash}: ${commit.headline}](#${commit.anchor})`,
			commit.files.map(file=>[
				`\t- [${file.name}](#${file.anchor})`
			])
		]),
		commits.map(commit=>[
			`# ${commit.headline}`,
			`> ${commit.hash}`,
			`\n${commit.body}`,
			commit.files.map(file=>[
				`## ${commit.headline}: ${file.name}`,
				`![${commit.headline}: ${file.name}](${file.imagePath})`
			])
		])
	]

	await fs.writeFileSync(`./${config.outputDirectory}/${config.outputFilename}`, flatten(markdown).join('\n'))
}
