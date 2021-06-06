// ==UserScript==
// @name        Base Share
// @description Base Share
// @namespace   https://cncapp*.alliances.commandandconquer.com/*/index.aspx*
// @include     https://cncapp*.alliances.commandandconquer.com/*/index.aspx*
// @icon        https://project-exception.net/download/scanner.png
// @updateURL   http://bruellhusten.de/baseshare.meta.js
// @downloadURL http://bruellhusten.de/baseshare.meta.js
// @version     20.09.18
// @author      Nogrod
// ==/UserScript==
(function () {
  var b = function () {
    function JarvisIsInstalled() {
      return typeof Jarvis !== "undefined" && Jarvis.getInstance().IsLoaded;
    }

    function killMe() {
      var a = document.getElementsByTagName("script");
      for (var i = 0; i < a.length; i++) {
        if (a[i].innerHTML.search(/icon_efficiency_target_range/g) != -1) {
          document.getElementsByTagName("head")[0].removeChild(a[i]);
          break;
        }
      }
    }

    function createTweak() {
      qx.Class.define("BaseShare", {
        type: "singleton",
        extend: qx.core.Object,
        members: {
          Trans: null,
          data: null,
          newData: null,
          processingData: null,
          cityData: {},
          updateTimeout: null,
          GetData: null,
          button: null,
          requested: null,
          Initialize: function () {
            try {
              this.GetData = this.FindMethod(ClientLib.Data.Cities.prototype, /OCITY/);
              if (typeof ClientLib.Data.WorldSector.WorldObjectNPCBase.prototype.get_Id === "undefined")
                this.QuickWrapProperty(
                  ClientLib.Data.WorldSector.WorldObjectNPCBase.prototype,
                  "$ctor",
                  /this\.([A-Z]{6,12})\s*\=\s*\(\w\.\$\w\s*\=\s*\$I\.[A-Z]{6,12}\.[A-Z]{6,12}\(\w,\s*\w,\s*\w\),\s*\w\s*\=\s*\w.\w,\s*\w\.\$\w\)\;\s*return\sthis\;/,
                  "get_Id"
                );
              if (typeof ClientLib.Data.City.prototype.Update === "undefined") {
                var tmp = this.FindMethod(ClientLib.Data.City.prototype, /Math\.(?:floor|round)\(a\.adb\)/);
                this.AliasMethod(ClientLib.Data.City.prototype, tmp, "Update");
              }
              this.data = [];
              this.newData = [];
              this.processingData = [];
              this.requested = [];
              this.button = new qx.ui.form.Button(
                null,
                "webfrontend/ui/icons/efficiency_icons/icon_efficiency_target_range.png"
              ).set({
                //FactionUI/icons/icon_search_rank.png
                padding: 0,
                toolTipText: "BaseShare",
              });
              this.addButtonToDesktop(this.button);
              //app.getDesktop().remove(button);
              this.button.addListener(
                "execute",
                function () {
                  setTimeout(this.Scan.bind(this), 0);
                },
                this
              );
              this.resizeIcon(this.button.getChildControl("icon"), 40);
              this.createAttackButtonPatch();
              this.createCityMovePatch();
              killMe();
            } catch (t) {
              console.log("BaseShare.init: " + t.message, t);
              console.error(t, t.stack);
            }
          },
          AliasMethod: function (_target, _oldName, _newName) {
            _target[_newName] = _target[_oldName];
          },
          QuickWrapProperty: function (_target, _fromName, _regexp, _funcName) {
            var tempName = this.FindRegexSubStr(_target[_fromName], _regexp, 1);
            _target[_funcName] = new Function("return function () {return this." + tempName + ";}")();
          },
          FindRegexSubStr: function (_funcStr, _regex, _pos) {
            _funcStr = typeof _funcStr === "function" ? _funcStr.toString() : _funcStr;
            var matches = _regex.exec(_funcStr);
            if (matches === null || _pos >= matches.length) {
              throw "FindRegexSubStr: no match error " + _regex.toString();
            }
            if (_pos == -1) {
              return matches;
            }
            return matches[_pos];
          },
          FindMethod: function (_target, _feats) {
            for (var key in _target) {
              if (typeof _target[key] === "function" && _feats.test(_target[key].toString())) {
                return key;
              }
            }
            throw "FindMethod Error: " + _feats;
          },
          resizeIcon: function (icon, size) {
            var newWidth, newHeight;
            if (icon._getContentHint().height === 0 || icon._getContentHint().width === 0) {
              setTimeout(this.resizeIcon.bind(this), 1000, icon, size);
              return;
            }
            if (icon._getContentHint().height > icon._getContentHint().width) {
              newWidth = icon._getContentHint().width * (size / icon._getContentHint().height);
              newHeight = size;
            } else {
              newWidth = size;
              newHeight = icon._getContentHint().height * (size / icon._getContentHint().width);
            }
            icon.set({
              scale: true,
              width: parseInt(newWidth, 10),
              height: parseInt(newHeight, 10),
            });
          },
          addButtonToDesktop: function (button) {
            var app = qx.core.Init.getApplication();
            app.getDesktop().add(button, {
              top: 5,
              right: app.getRightBar().getBounds().width + 5,
            });
          },
          createCityMovePatch: function () {
            if (typeof ClientLib.Data.City.prototype.MoveToResult === "undefined") {
              var tmp = this.FindRegexSubStr(ClientLib.Data.City.prototype.MoveTo, /\.[A-Z]{6,12}\(this\,this\.([A-Z]{6,12})\)/, 1);
              this.AliasMethod(ClientLib.Data.City.prototype, tmp, "MoveToResult");
              ClientLib.Data.City.prototype[tmp] = function (a, b) {
                this.MoveToResult(a, b);
                var scanner = BaseShare.getInstance();
                setTimeout(scanner.Scan.bind(scanner), 1000);
              };
            }
          },
          createAttackButtonPatch: function () {
            //reset att btn patch
            if (typeof webfrontend.gui.region.RegionCityMenu.prototype.showMenuAttPatch !== "undefined") {
              webfrontend.gui.region.RegionCityMenu.prototype.showMenu =
                webfrontend.gui.region.RegionCityMenu.prototype.showMenuAttPatch;
              webfrontend.gui.region.RegionCityMenu.prototype.onTick =
                webfrontend.gui.region.RegionCityMenu.prototype.onTickAttPatch;
            }
            webfrontend.gui.region.RegionCityMenu.prototype.updateAtkBtn = function () {
              if (typeof this.selectedVisObject === "undefined" || this.selectedVisObject === null) {
                return;
              }
              if (typeof this.atkBtn === "undefined") {
                this.atkBtn = [];
                for (var i in this) {
                  if (this[i] && this[i].basename == "Composite") {
                    var children = this[i].getChildren();
                    for (var child in children) {
                      if (children[child].basename == "SoundButton" && children[child].getLabel().indexOf("!") != -1) {
                        this.atkBtn.push(children[child]);
                        break;
                      }
                    }
                  }
                }
              }
              var city = ClientLib.Data.MainData.GetInstance().get_Cities().get_CurrentCity();
              if (city === null) {
                return;
              }
              var scanner = BaseShare.getInstance();
              var cityId = city.get_Id();
              //console.log(city.get_Id() + " " + city.get_OwnerId());
              if (city.get_OwnerId() === 0 && this.selectedVisObject.get_VisObjectType() === ClientLib.Vis.VisObject.EObjectType.RegionNPCBase) {
                var minDistance = -1;
                var cities = ClientLib.Data.MainData.GetInstance().get_Cities().get_AllCities().d;
                for (var id in cities) {
                  var selectedBase = cities[id];
                  var iX = Math.abs(selectedBase.get_PosX() - this.selectedVisObject.get_RawX());
                  var iY = Math.abs(selectedBase.get_PosY() - this.selectedVisObject.get_RawY());
                  var distance = iX * iX + iY * iY;
                  if (minDistance === -1 || distance < minDistance) minDistance = distance;
                }
                var maxDistance = ClientLib.Data.MainData.GetInstance().get_Server().get_MaxAttackDistance();
                if (minDistance > maxDistance * maxDistance) {
                  if (typeof scanner.requested[cityId] === "undefined") {
                    scanner.requested[cityId] = null;
                    var request = new window.XMLHttpRequest();
                    var worldid = ClientLib.Data.MainData.GetInstance().get_Server().get_WorldId();
                    request.open(
                      "GET",
                      "https://project-exception.net/download/script/base.php?wid=" + worldid + "&bid=" + cityId,
                      true
                    );
                    request.onload = function () {
                      if (!this.responseText) {
                        setTimeout(function () {
                          delete scanner.requested[cityId];
                        }, 30 * 1000);
                        return;
                      }
                      scanner.requested[cityId] = { l: [JSON.parse(this.responseText)] };
                    };
                    request.onerror = function () {
                      setTimeout(function () {
                        delete scanner.requested[cityId];
                      }, 30 * 1000);
                    };
                    request.send();
                  } else if (
                    scanner.requested[cityId] !== null &&
                    city.get_Version() < scanner.requested[cityId].l[0].v
                  ) {
                    ClientLib.Data.MainData.GetInstance().get_Cities().UpdateCity(null, scanner.requested[cityId]);
                  }
                }
                return;
              }
              if (city.get_OwnerId() === 0 && (typeof scanner.requested[cityId] === "undefined" || scanner.requested[cityId] === null)) return;
              for (var i = 0; i < this.atkBtn.length; i++) {
                if (this.atkBtn[i].isVisible()) {
                  this.atkBtn[i].setEnabled(true);
                }
              }
            };
            webfrontend.gui.region.RegionCityMenu.prototype.showMenuAttPatch =
              webfrontend.gui.region.RegionCityMenu.prototype.showMenu;
            webfrontend.gui.region.RegionCityMenu.prototype.showMenu = function (selectedVisObject) {
              this.showMenuAttPatch(selectedVisObject);
              this.selectedVisObject = selectedVisObject;
              this.updateAtkBtn();
            };
            webfrontend.gui.region.RegionCityMenu.prototype.onTickAttPatch =
              webfrontend.gui.region.RegionCityMenu.prototype.onTick;
            webfrontend.gui.region.RegionCityMenu.prototype.onTick = function () {
              this.onTickAttPatch();
              this.updateAtkBtn();
            };
          },
          Scan: function () {
            try {
              this.button.setEnabled(false);
              this.data = [];
              this.newData = [];
              this.processingData = [];
              var visMode = ClientLib.Vis.VisMain.GetInstance().get_Mode();
              if (visMode != ClientLib.Vis.Mode.Region) {
                ClientLib.Vis.VisMain.GetInstance().set_Mode(ClientLib.Vis.Mode.Region);
                ClientLib.Vis.VisMain.GetInstance().set_Mode(visMode);
              }
              var maxDistance = ClientLib.Data.MainData.GetInstance().get_Server().get_MaxAttackDistance();
              var world = ClientLib.Data.MainData.GetInstance().get_World();
              var cities = ClientLib.Data.MainData.GetInstance().get_Cities().get_AllCities().d;
              for (var id in cities) {
                var selectedBase = cities[id];
                console.log("Scanning from: " + selectedBase.get_Name());
                var baseX = selectedBase.get_PosX();
                var baseY = selectedBase.get_PosY();
                for (var y = baseY - Math.ceil(maxDistance); y <= baseY + Math.ceil(maxDistance); y++) {
                  for (var x = baseX - Math.ceil(maxDistance); x <= baseX + Math.ceil(maxDistance); x++) {
                    var iX = Math.abs(baseX - x);
                    var iY = Math.abs(baseY - y);
                    var distance = iX * iX + iY * iY;
                    if (distance <= maxDistance * maxDistance) {
                      var obj = world.GetObjectFromPosition(x, y);
                      if (obj !== null) {
                        switch (obj.Type) {
                          case ClientLib.Data.WorldSector.ObjectType.NPCBase:
                            this.newData.push([obj.get_Id(), -1, "", x + ":" + y]);
                            break;
                        }
                      }
                    }
                  }
                }
              }
              if (this.newData.length > 0) {
                this.processingData = this.newData.splice(0, 75);
                var com = ClientLib.Net.CommunicationManager.GetInstance();
                com.RegisterDataReceiver(
                  "OCITY",
                  phe.cnc.Util.createEventDelegate(ClientLib.Net.UpdateData, this, this.ReceiveData)
                );
                var requester = {};
                requester[this.GetData] = function () {
                  var scanner = BaseShare.getInstance();
                  if (scanner.processingData !== null && scanner.processingData.length > 0) {
                    var curId = scanner.processingData[0][0];
                    var result, curData;
                    if (typeof scanner.cityData[curId] === "undefined") {
                      result = curId + ":-1:0";
                    } else {
                      curData = scanner.cityData[curId];
                      result = curId + ":" + curData.v + ":" + (curData.am === null ? 0 : curData.am.length);
                    }
                    for (var i = 1; i < scanner.processingData.length; i++) {
                      curId = scanner.processingData[i][0];
                      if (typeof scanner.cityData[curId] === "undefined") {
                        result += "\\fOCITY:" + curId + ":-1:0";
                      } else {
                        curData = scanner.cityData[curId];
                        result +=
                          "\\fOCITY:" + curId + ":" + curData.v + ":" + (curData.am === null ? 0 : curData.am.length);
                      }
                    }
                    return result;
                  }
                  return null;
                };
                com.RegisterDataRequester("OCITY", requester);
                this.updateTimeout = setTimeout(this.UpdateData.bind(this), 2000);
              } else {
                this.StopScan();
              }
            } catch (O) {
              this.StopScan();
              console.log("BaseShare Scan error: " + O.stack);
            }
          },
          ReceiveData: function (tag, data) {
            clearTimeout(this.updateTimeout);
            var $a = data.l;
            var cityData;
            for (var $b = 0; $b < $a.length; $b++) {
              cityData = $a[$b];
              if (typeof cityData.i !== "undefined") {
                this.cityData[cityData.i] = cityData;
              }
            }
            for (var i = 0; i < this.processingData.length; i++) {
              if (typeof this.cityData[this.processingData[i][0]] === "undefined") {
                return;
              }
            }
            this.updateTimeout = setTimeout(this.UpdateData.bind(this), 1500);
          },
          UpdateData: function () {
            for (var i = 0; i < this.processingData.length; i++) {
              if (typeof this.cityData[this.processingData[i][0]] === "undefined") {
                return;
              }
            }
            var city = new ClientLib.Data.City().$ctor(0);
            for (var i = 0; i < this.processingData.length; i++) {
              posData = this.processingData[i][3] !== null ? this.processingData[i][3].split(":") : [];
              if (posData.length == 2) {
                var cityId = this.processingData[i][0];
                var posX = parseInt(posData[0], 10);
                var posY = parseInt(posData[1], 10);
                if (typeof this.cityData[cityId] !== "undefined") {
                  city.Update(this.cityData[cityId]);
                  if (!city.get_IsGhostMode()) {
                    this.processingData[i][2] = city.get_Name();
                    if (city.GetBuildingsConditionInPercent() !== 0) {
                      this.processingData[i][1] = 0;
                    } else {
                      console.info(
                        this.processingData[i][2],
                        " on ",
                        posX,
                        posY,
                        " removed (GetBuildingsConditionInPercent === 0)",
                        cityId
                      );
                    }
                  } else {
                    console.info(this.processingData[i][2], " on ", posX, posY, " removed (IsGhostMode)", cityId);
                  }
                }
              }
            }
            for (var i = this.processingData.length - 1; i >= 0; i--) {
              if (this.processingData[i][1] == -1) {
                this.processingData.splice(i, 1);
              }
            }
            this.StopScan();
          },
          StopScan: function () {
            this.data = this.data.concat(this.processingData);
            if (this.newData.length > 0) {
              this.processingData = this.newData.splice(0, 75);
              this.updateTimeout = setTimeout(this.UpdateData.bind(this), 2000);
              return;
            }
            this.processingData = [];
            var com = ClientLib.Net.CommunicationManager.GetInstance();
            //com.UnregisterDataRequester("OCITY");
            //com.UnregisterDataReceiver("OCITY");
            var cities = ClientLib.Data.MainData.GetInstance().get_Cities();
            com.RegisterDataReceiver(
              "OCITY",
              phe.cnc.Util.createEventDelegate(ClientLib.Net.UpdateData, cities, cities.UpdateCity)
            );
            com.RegisterDataRequester("OCITY", cities);
            this.button.setEnabled(true);
            setTimeout(this.onScannedData.bind(this), 0);
          },
          sendData: function (data) {
            //console.log(data);
            var request = new window.XMLHttpRequest();
            request.open("POST", "https://project-exception.net/download/script/base.php", true);
            request.setRequestHeader("Content-type", "application/json");
            request.onload = function () {
              //console.log(JSON.parse(this.responseText));
            };
            request.send(JSON.stringify(data));
          },
          onScannedData: function () {
            this.sendData({
              action: "send",
              worldid: ClientLib.Data.MainData.GetInstance().get_Server().get_WorldId(),
              worldname: ClientLib.Data.MainData.GetInstance().get_Server().get_Name(),
              data: this.cityData,
            });
          },
        },
      });
      console.info("BaseShare initalisiert");
    }

    function checkIfLoaded() {
      try {
        if (
          typeof qx !== "undefined" &&
          qx.core.Init.getApplication() !== null &&
          qx.core.Init.getApplication().getMenuBar() !== null
        ) {
          createTweak();
          BaseShare.getInstance().Initialize();
        } else {
          setTimeout(checkIfLoaded, 1000);
        }
      } catch (k) {
        console.debug("BaseShare checkIfLoaded: ", k);
      }
    }
    setTimeout(checkIfLoaded, 5000);
  };
  var a = document.createElement("script");
  a.innerHTML = "(" + b.toString() + ")();";
  a.type = "text/javascript";
  document.getElementsByTagName("head")[0].appendChild(a);
})();
