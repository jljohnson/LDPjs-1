module.exports = function(app, db) {
	var url = require('url');
	var ldp = require('./vocab/ldp.js');			// LDP vocabulary
	var media = require('./media.js');				// media types
	var N3 = require('n3');
	var crypto = require('crypto');					// for MD5 (ETags)

	// route any requests matching /r/*
	var resource = app.route('/r/*');
	resource.all(function(req, res, next) {
		// all responses should have Link: <ldp:Resource> rel=type
		res.links({
			type: ldp.Resource
		});
		next();
	});

	resource.get(function(req, res, next) {
		console.log('GET ' + req.path);
		db.get(req.fullURL, function(err, triples, interactionModel) {
			if (err) {
				console.log(err.stack);
				res.send(500);
				return;
			}

			if (!triples) {
				res.send(404);
				return;
			}

			res.links({
				type: ldp.RDFSource
			});

			if (interactionModel === ldp.BasicContainer) {
				res.links({
					type: ldp.BasicContainer
				});

				// add in ldp:contains triples
				db.getContainment(req.fullURL, function(err, containment) {
					if (err) {
						console.log(err.stack);
						res.send(500);
						return;
					}

					containment.forEach(function(resource) {
						triples.push({
							subject: req.fullURL,
							predicate: ldp.contains,
							object: resource
						});
					});

					writeTurtle(req, res, triples);
				});	
			} else {
				writeTurtle(req, res, triples);
			}
		});
	});

	resource.put(function(req, res, next) {
		console.log('PUT ' + req.path);
		if (!req.is('text/turtle')) {
			res.send(415);
			return;
		}

		parse(req, req.fullURL, function(err, triples, interactionModel) {
			if (err) {
				res.send(400);
				return;
			}

			// get the resource to check if it exists and check its ETag
			db.get(req.fullURL, function(err, originalTriples, originalInteraction) {
				db.put(req.fullURL, null, interactionModel, triples, function(err) {
					if (err) {
						console.log(err.stack);
						res.send(500);
						return;
					}

					res.send(triples ? 204 : 201)
				});
			});
		});
	});

	resource.post(function(req, res, next) {
		console.log('POST ' + req.path);
		if (!req.is('text/turtle')) {
			res.send(415);
			return;
		}

		db.isContainer(req.fullURL, function(err, result) {
			if (err) {
				console.log(err.stack);
				res.send(500);
				return;
			}

			console.log('isContainer: ' + result);
			
			if (!result) {
				res.send(409);
				return;
			}

			var loc = req.fullURL
						   + ((req.fullURL.substr(-1) == '/') ? '' : '/')
						   + 'res' + Date.now();
			parse(req, loc, function(err, triples, interactionModel) {
				if (err) {
					res.send(400);
					return;
				}
			   
				db.put(loc, req.fullURL, interactionModel, triples, function(err) {
					if (err) {
						console.log(err.stack);
						res.send(500);
						return;
					}
				
					res.location(loc).send(201);	
				});
			});
		});
	});

	resource.delete(function(req, res, next) {
		console.log('DELETE: ' + req.path);
		db.remove(req.fullURL, function(err, result) {
			if (err) {
				console.log(err.stack);
				res.send(500);
				return;
			}

			res.send(result ? 204 : 404);
		});
	});

	resource.options(function(req, res, next) {
		db.get(req.fullURL, function(err, triples, interactionModel) {
			if (err) {
				console.log(err.stack);
				res.send(500);
				return;
			}

			if (!triples) {
				res.send(404);
				return;
			}

			res.links({
				type: ldp.RDFSource
			});

			var allow = 'GET,PUT,DELETE,OPTIONS';
			if (interactionModel === ldp.BasicContainer) {
				res.links({
					type: ldp.BasicContainer
				});

				allow += ',POST';
				res.set('Accept-Post', media.turtle);
			}

			res.set('Allow', allow);
			res.send(200);
		});
	});

	function parse(req, resourceURI, callback) {
		var parser = N3.Parser();
		var triples = [];
		var interactionModel = ldp.RDFSource;
		parser.parse(req.rawBody, function(err, triple) {
			if (err) {
				callback(err);
				return;
			}

			if (triple) {
				// resolve the null relative URI
				if (triple.subject === '') {
					triple.subject = resourceURI;

				}

				// if this triple is <> rdf:type ldp:BasicContainer RDF type,
				// set the interaction model as BasicContainer
				if (triple.subject === resourceURI
					&& triple.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
					&& triple.object === ldp.BasicContainer) {
						interactionModel = ldp.BasicContainer;
				}

				triples.push(triple);
				return;
			}

			callback(null, triples, interactionModel);
		});
	}

	function asTurtle(triples, callback) {
		var writer = N3.Writer();
		writer.addTriples(triples);
		writer.end(callback);
	}

	function getETag(turtle) {
		return 'W/"' + crypto.createHash('md5').update(turtle).digest('hex') + '"';
	}

	function writeTurtle(req, res, triples) {
		asTurtle(triples, function(err, turtle) {
			if (err) {
				res.send(500);
			} else {
				var eTag = getETag(turtle);
				if (req.get('If-None-Match') === eTag) {
					res.send(304);
					return;
				}

				res.writeHead(200, { 'ETag': eTag, 'Content-Type': media.turtle });
				res.end(new Buffer(turtle), 'utf-8');
			}
		});
	}
};
