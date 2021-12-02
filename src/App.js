import React, { useState, useEffect } from 'react';
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader'
import * as THREE from 'three'
import * as dat from 'dat.gui'
import './App.css';
import Scoring from "./Components/scoring"
import { Vector3 } from 'three';
import socketIOClient from "socket.io-client";
import Peer from 'peerjs';
import Axios from "axios";

function App() {
  const [panel, setPanel] = useState(false);
  const [creationForm, setCreationForm] = useState(false);
  const [currentPortal, setCurrentPortal] = useState({});
  const [globalPortalArr, setGlobalPortalArr] = useState([]);

  const [userId, setUserId] = useState();
  const [formName, setFormName] = useState();
  const [formImg, setFormImg] = useState();
  const [formDescr, setFormDescr] = useState();
  const [playerPosition, setPlayerPosition] = useState();
  const [submitFunction, setSubmitFunction] = useState(false);

  // useEffect(() => console.log("globalPortalArr", globalPortalArr), [globalPortalArr]);
  // useEffect(() => console.log("currentPortal", currentPortal), [currentPortal]);


  useEffect(() => {
    // console.log("STATUS", submitFunction)
    if (submitFunction == true) {
      console.log("playerPosition", playerPosition)
      console.log({ user: userId, portal: { name: formName, img: formImg, description: formDescr, position: playerPosition, energy: 30 } })
      Axios.post('https://whispiserver.herokuapp.com/portalCreation', { user: userId, portal: { name: formName, img: formImg, description: formDescr, position: playerPosition, energy: 30 }})
      setSubmitFunction(false)
    } else {
      // console.log("NOPE", submitFunction)
    }
  }, [submitFunction]);

  useEffect(() => {
    const ENDPOINT = "https://whispiserver.herokuapp.com/";
    // const ENDPOINT = "http://localhost:4100/";

    const videoGrid = document.getElementById("video-grid");

    // let inicometArr = []
    let sw = false;
    let myPeer;
    let character;
    let userScore = 0;
    let portalArr = [];
    let creationFormLocal = false;
    let formNameLocal = false;
    let formImgLocal = false;
    let formDescrLocal = false;


    const myAudio = document.createElement("video");
    myAudio.muted = true;

    //PeerJS
    myPeer = new Peer(undefined);
    const peers = [];

    //Socket
    const socket = socketIOClient(ENDPOINT);
    //FALOPEADA

    console.log("SUBMIIIT", submitFunction)

    navigator.mediaDevices.getUserMedia({
      audio: true,
    }).then(stream => {
      addVideoStream(myAudio, stream);

      // socket.on("user-entity", userArr => {
      //   console.log(userArr, "userArr")
      // })


      socket.on("user-position", userArr => {
        for (const property in userArr) {
          let avatar = scene.getObjectByName(property);
          if (avatar && avatar.name != myPeer.id) {
            avatar.position.set(userArr[property].position.x, userArr[property].position.y, userArr[property].position.z)
          }
        }
      })


      socket.on("comet-position", comeTar => {
        // console.log("ada", comeTar)
        // if(inicometArr.length == 0){
        //   inicometArr = comeTar;
        //   console.log("INITCOM",inicometArr )
        // } else {
        //   cometArr = comeTar;
        //   console.log("COMET",cometArr )
        // }


        // cometArr = comeTar;
        // console.log("sended", cometArr)
        if (sw == false) {
          for (let i = 0; i < 50; i++) {
            let comet = new THREE.Mesh(sphereGeo, Material);
            comet.position.x = comeTar[i].position.x
            comet.position.y = comeTar[i].position.y
            comet.position.z = comeTar[i].position.z
            comet.name = i;
            scene.add(comet)
          }
        } else {
          for (let i = 0; i < 50; i++) {
            let targetComet = scene.getObjectByName(i)
            targetComet.position.x = comeTar[i].position.x
            targetComet.position.y = comeTar[i].position.y
            targetComet.position.z = comeTar[i].position.z

          }
        }
        sw = true;
      })

      myPeer.on("call", call => {
        call.answer(stream)
        const audio = document.createElement("audio");

        call.on("stream", userVideoStream => {
          addVideoStream(audio, userVideoStream);
        })
      })

      socket.on("user-connected", userId => {

        gltfLoader.load(
          'comet.gltf',
          (model) => {
            model.scene.position.set(0, 0, 0);
            model.scene.children[0].name = userId;
            model.scene.scale.set(0.5, 0.5, 0.5)
            scene.add(model.scene.children[0].clone())
          }
        )

        connectToNewUser(userId, stream);
      })

      socket.on("user-disconnected", userId => {
        console.log(peers)
        peers[userId] && peers[userId].close();
        let target = scene.getObjectByName(userId);
        console.log("TARGET", target);
        scene.remove(target)
      })

    })

    const Material = new THREE.MeshMatcapMaterial({ color: 'orange' });
    const sphereGeo = new THREE.SphereGeometry(0.3, 30, 30);

    myPeer.on("open", id => {
      socket.emit("join-room", "room1", id)

      setUserId(myPeer.id)
      // Axios.get('https://whispiserver.herokuapp.com/userArr')
      Axios.get('https://whispiserver.herokuapp.com/userArr')
        .then(function (response) {
          console.log("xDDD", response.data)

          for (const property in response.data) {
            gltfLoader.load(
              'comet.gltf',
              (model) => {
                model.scene.position.set(0, 0, 0);
                model.scene.children[0].name = property;
                model.scene.scale.set(0.5, 0.5, 0.5)
                scene.add(model.scene.children[0])
                character = scene.getObjectByName(property);

                if (property == myPeer.id) {
                  controls.target = character.position;
                  character.lookAt(camera.position)
                }
              }
            )
          }

          Axios.get('https://whispiserver.herokuapp.com/portalArr')
            .then(function (data) {
              portalArr = data["data"];
              portalArr.length > 0 && portalArr.forEach((portal) => {
                gltfLoader.load(
                  'portal.gltf',
                  (model) => {
                    model.scene.position.set(portal.position.x, portal.position.y, portal.position.z);
                    model.scene.children[0].name = "portal";
                    model.scene.scale.set(2, 2, 2)
                    scene.add(model.scene.clone())
                  }
                )
              })
            })
        })
    })

    socket.on("eating-sound", data => {
      if (data.id == myPeer.id) {
        userScore = data.score;
        let rndSound = Math.ceil(Math.random() * 4)
        switch (rndSound) {
          case 1:
            eating1.play()
            break;
          case 2:
            eating2.play()
            break;
          case 3:
            eating3.play()
            break;
          case 4:
            eating4.play()
            break;
        }

      }
    })

    socket.on("portal-spawn", portal => {
      console.log("PORTALLL", portal);
      if (portal["type"] == "create") {
        gltfLoader.load(
          'portal.gltf',
          (model) => {
            model.scene.position.x = portal["portal"].position.x
            model.scene.position.y = portal["portal"].position.y
            model.scene.position.z = portal["portal"].position.z

            model.scene.name = portal["portal"].id;
            model.scene.scale.set(2, 2, 2)
            scene.add(model.scene.clone())
            console.log("A NEW PORTAL HAS SPAWNED", portal["portal"]);
          }
        )
      } else {
        console.log("PORTAL DEATH", portal)
        let target = scene.getObjectByName(portal["portal"].id);
        setPanel(false);
        console.log("TARGET", target);
        scene.remove(target)
      }

      portalArr = portal["array"];

    })

    socket.on("portal-update", portal => {
      portalArr = portal;
    })

    function connectToNewUser(userId, stream) {
      const call = myPeer.call(userId, stream);
      const audio = document.createElement("audio");
      call.on("stream", userVideoStream => {
        addVideoStream(audio, userVideoStream)
      })

      call.on("close", () => {
        audio.remove()
      })

      peers[userId] = call;
    }

    function addVideoStream(audio, stream) {
      audio.srcObject = stream;
      audio.addEventListener("loadedmetadata", () => {
        audio.play()
      })

      videoGrid.append(audio)

    }

    const canvas = document.querySelector('canvas.webgl');
    // const raycaster = new THREE.Raycaster()
    // Debug
    const gui = new dat.GUI()


    const keys = { forward: false, boost: false }
    // Scene

    const cubeTextureLoader = new THREE.CubeTextureLoader()

    const environmentMapTexture = cubeTextureLoader.load([
      '/environment/px.png',
      '/environment/nx.png',
      '/environment/py.png',
      '/environment/ny.png',
      '/environment/pz.png',
      '/environment/nz.png'
    ])

    const scene = new THREE.Scene()
    scene.background = environmentMapTexture;

    const axesHelper = new THREE.AxesHelper(5);
    // scene.add(axesHelper);

    //Texture Loader

    const loadingManager = new THREE.LoadingManager()
    const textureLoader = new THREE.TextureLoader(loadingManager)
    const colorTexture = textureLoader.load("/color.jpg")

    //Model Loader

    // const fbxLoader = new FBXLoader()
    // fbxLoader.load(
    //   'user.fbx',
    //   (gltf) => {
    //     console.log("FBX",gltf)
    //     scene.add(gltf.children[0])
    //   }
    // )

    const gltfLoader = new GLTFLoader()

    // environmentMapTexture.MinFilter = THREE.LinearFilter


    /**
  * Sizes
  */
    const sizes = {
      width: window.innerWidth,
      height: window.innerHeight
    }

    /**
     * Renderer
     */
    const renderer = new THREE.WebGLRenderer({
      canvas: canvas
    })
    renderer.setSize(sizes.width, sizes.height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

    window.addEventListener('resize', () => {
      // Update sizes
      sizes.width = window.innerWidth
      sizes.height = window.innerHeight

      // Update camera
      camera.aspect = sizes.width / sizes.height
      camera.updateProjectionMatrix()


      // Update renderer
      renderer.setSize(sizes.width, sizes.height)
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    })

    /**
 * Camera
 */
    // Base camera
    const camera = new THREE.PerspectiveCamera(75, sizes.width / sizes.height, 0.1, 1000)
    camera.position.z = 3;
    camera.position.y = 1;
    scene.add(camera)


    //Music
    const listener = new THREE.AudioListener();
    camera.add(listener);

    // create a global audio source
    const soundtrack = new THREE.Audio(listener);
    const boostfx = new THREE.Audio(listener);
    const eating1 = new THREE.Audio(listener);
    const eating2 = new THREE.Audio(listener);
    const eating3 = new THREE.Audio(listener);
    const eating4 = new THREE.Audio(listener);


    const audioLoader = new THREE.AudioLoader();
    audioLoader.load('whispiverse.mp3', function (buffer) {
      soundtrack.setBuffer(buffer);
      soundtrack.setLoop(true);
      soundtrack.setVolume(0.5);
      soundtrack.play();
    });

    audioLoader.load('boostfx.mp3', function (buffer) {
      boostfx.setBuffer(buffer);
      boostfx.setVolume(0.2);
    });

    audioLoader.load('./sounds/collect1.mp3', function (buffer) {
      eating1.setBuffer(buffer);
      eating1.setVolume(0.2);
    });

    audioLoader.load('./sounds/collect2.mp3', function (buffer) {
      eating2.setBuffer(buffer);
      eating2.setVolume(0.2);
    });

    audioLoader.load('./sounds/collect3.mp3', function (buffer) {
      eating3.setBuffer(buffer);
      eating3.setVolume(0.2);
    });

    audioLoader.load('./sounds/collect4.mp3', function (buffer) {
      eating4.setBuffer(buffer);
      eating4.setVolume(0.2);
    });

    /**
     * Objects
     */

    // const character = new THREE.Group()
    // scene.add(character)

    //Character
    // const character = new THREE.Mesh(
    //   new THREE.SphereGeometry(0.5, 16, 16),
    //   new THREE.MeshBasicMaterial({ color: 'white', map: colorTexture, side: THREE.DoubleSide })
    // )


    // const ref = new THREE.Mesh(
    //   new THREE.SphereGeometry(0.5, 8, 8),
    //   new THREE.MeshBasicMaterial({ color: 'red', })
    // )



    // movement - please calibrate these values

    var speed = 8;

    //Light

    const light = new THREE.AmbientLight(0xffffff, 4);
    scene.add(light);

    function distanceToPortals() {
      let sw = false;
      portalArr.length > 0 && portalArr.forEach((portal, i) => {
        if (character.position.distanceTo(portal.position) < 10) {
          sw = i
        }
      })
      return sw;
    }


    document.addEventListener("keydown", onDocumentKeyDown, false);
    function onDocumentKeyDown(event) {
      var keyCode = event.which;
      if (keyCode == 87) {
        //Character position
        keys["forward"] = true
      } else if (keyCode == 16) {
        // console.log("boost");
        keys["boost"] = true;
      } else if (keyCode == 32) {
        let closePortal = distanceToPortals()
        if (userScore >= 3 && closePortal == false) {
          console.log("userscore", userScore);
          if (creationFormLocal == false) {
            creationFormLocal = true;
          } else {
            creationFormLocal = false;
          }
          // userScore = userScore - 3;
          // socket.emit("portalCreation", { user: myPeer.id, portal: { name: "Not going to make it. How to off myself?", img: "defaultImage.jpg", description: "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.", position: new THREE.Vector3(character.position.x, character.position.y, character.position.z), energy: 30 } });
        } 
        if (userScore > 0 && closePortal !== false) {
          console.log("AFDASDASDAD", closePortal);
          userScore = userScore - 1;
          socket.emit("portalFeeding", { user: myPeer.id, portal: closePortal });

        }
      }
    }

    document.addEventListener("keyup", onDocumentKeyUp, false);
    function onDocumentKeyUp(event) {
      var keyCode = event.which;
      if (keyCode == 87) {
        //Character position
        keys["forward"] = false
      } else if (keyCode == 16) {
        // console.log("boost");
        keys["boost"] = false;
      }
    }


    // Controls
    const controls = new OrbitControls(camera, canvas)
    controls.enableDamping = true;
    OrbitControls.enableKeys = false;
    controls.maxDistance = 6;
    controls.minDistance = 6;
    controls.enablePan = false;

    function handleChange(e) {
      e.preventDefault();
      console.log("SUCESSSSSSS")
    }


    //Comets

    // let cometArr = [];

    // function randomPos(target) {
    //   target.position.x = (Math.random() - 0.5) * 100;
    //   target.position.y = (Math.random() - 0.5) * 100;
    //   target.position.z = (Math.random() - 0.5) * 100;

    //   target.rotation.x = Math.random() * Math.PI
    //   target.rotation.y = Math.random() * Math.PI
    // }

    /**
     * Animate
     */

    //comet target
    // let comeTar = [];
    // let genCounter = 0;
    // let timeRare = 10;

    // function generateTargets() {
    //   cometArr.forEach(function (item, i) {
    //     let rngTarget = new Vector3((Math.random() - 0.5) * 100, (Math.random() - 0.5) * 100, (Math.random() - 0.5) * 100);
    //     comeTar.push(rngTarget);
    //   })

    // console.log("init", comeTar)
    // }

    // generateTargets()

    // let arrCount = 0;

    const clock = new THREE.Clock()
    const tick = () => {
      const elapsedTime = clock.getElapsedTime()
      setCreationForm(creationFormLocal);
      character && setPlayerPosition(character.position);
      // genCounter = elapsedTime;

      // Update controls
      controls.update()

      // console.log(character.position.distanceTo(camera.position))
      // character.rotation.y = -controls.getPolarAngle()

      //Raycaster
      // const rayDirection = new Vector3().copy(character.position).sub(camera.position).normalize();
      // raycaster.set(character.position, rayDirection)

      // const intersect = raycaster.intersectObjects(cometArr)

      // if(intersect.length > 0){
      //   intersect.forEach((hit)=> {
      //     if(hit.distance < 0.3){
      //       hit.object.visible = false;
      //       energy++
      //       console.log(energy)
      //     }
      //   })
      // }

      // scene.add(new THREE.ArrowHelper(raycaster.ray.direction, raycaster.ray.origin, 300, 0xff0000) );


      // console.log("intersect", intersect)

      if (keys.forward == true) {
        character.position.add(new Vector3().copy(character.position).sub(camera.position).normalize().divide(new Vector3(speed, speed, speed)))
      }

      //Side Panel
      if (character && portalArr && portalArr.length > 0) {
        let sw = false;
        setPanel(false);
        setCurrentPortal([]);

        portalArr.forEach((item, i) => {
          if (character.position.distanceTo(item.position) < 5) {
            setPanel(true);
            setCurrentPortal(i);
            setGlobalPortalArr(portalArr)
            sw = true;
          }
        })
      }

      if (keys.boost == true) {
        speed = 4;
        // boostfx.play()
        setTimeout(function () {
          speed = 8;
        }, 4000)
      }
      // console.log("DISTANCE", character.position)

      //comets     

      // if (character.position.distanceTo(item.position) < 1) {
      // eatingSound();
      //  changeEnergy()
      // }


      // socket.emit("comet", currentCometPos );


      // console.log("GC", genCounter)

      // if (genCounter > timeRare) {
      //   timeRare = timeRare + 10;
      //   comeTar = [];
      //   for (let i = 0; i < 50; i++) {
      //     let rngTarget = new Vector3((Math.random() - 0.5) * 100, (Math.random() - 0.5) * 100, (Math.random() - 0.5) * 100);
      //     comeTar.push(rngTarget);
      //   }
      // }

      character && socket.emit("movement", character.position, myPeer.id);

      // Render
      renderer.render(scene, camera)


      // Call tick again on the next frame
      window.requestAnimationFrame(tick)
    }

    tick()


  }, []);

  // function changeEnergy(){
  //   setEnergy(energy + 1)
  //   console.log("xDdd", energy)
  // }


  return (
    <div>
      {/* <Scoring energy = {energy}></Scoring>
      <h1>energy {energy}</h1> */}
      <canvas class="webgl"></canvas>
      <div id="video-grid"></div>
      <div id="viewport">
        {panel == true && globalPortalArr.length > 0 && globalPortalArr[currentPortal] && <div id="menuPanel">
          <img class="logoStyle" src={globalPortalArr[currentPortal]["img"]}></img>
          <div class="prInfo">
            <h1>{globalPortalArr[currentPortal]["name"]}</h1>
            <p>{globalPortalArr[currentPortal]["description"]}</p>
          </div>
          <div class="remainingTime">
            <p class="secTitle">{globalPortalArr[currentPortal]["energy"]}</p>
            <p class="secDescr">Seconds Remaining</p>
          </div>
          <h2>Press spacebar to feed!</h2>
        </div>}

        {creationForm == true && panel == false && <div id="menuPanel">
          <div class="prInfo">
            <h1>Create a new portal</h1>
            <p>Description</p>
          </div>
          <div>
            <form enctype="multipart/form-data">
              <label>
                Name:
                <input type="text" onChange={(e => { setFormName(e.target["value"]) })} />
              </label>
              <label>
                Description:
                <input type="text" onChange={(e => { setFormDescr(e.target["value"]) })} />
              </label>
              <input type="button" onClick={e => { setSubmitFunction(true) }} />
              <input
                type="file"
                accept="image/png, image/gif, image/jpeg"
                name="postImg" 
                onChange={(e) => setFormImg(e.target.files[0])}
              />
            </form>
          </div>
          <h2>Create</h2>
        </div>}
        <div class="camera">
          <canvas class="webgl"></canvas>
        </div>
      </div>

    </div>

  )
}

export default App;